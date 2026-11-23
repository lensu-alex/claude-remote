import type { SupabaseClient } from "@supabase/supabase-js";

export type PushSupport = "ok" | "needs-home-screen" | "unsupported";

export function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; the touch check tells them apart.
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  const legacy = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return legacy || window.matchMedia("(display-mode: standalone)").matches;
}

export function pushSupport(): PushSupport {
  const hasApis = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (hasApis) return "ok";
  // On iPhone the push APIs only exist once the site is opened from the Home Screen.
  if (isIos() && !isStandalone()) return "needs-home-screen";
  return "unsupported";
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

function keyToBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== "ok") return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

export async function enablePush(sb: SupabaseClient): Promise<void> {
  const { data, error } = await sb.from("app_settings").select("value").eq("key", "vapid_public_key").maybeSingle();
  if (error) throw error;
  const publicKey = typeof data?.value === "string" ? data.value : "";
  if (!publicKey) {
    throw new Error("No laptop has been set up yet. Run `remote on` on a laptop once, then try again.");
  }

  // Must be asked from a tap, which is why this runs straight from the button handler.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notifications are blocked for this site. Allow them in your phone's settings, then try again.");
  }

  const registration = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready);
  await navigator.serviceWorker.ready;

  // Start clean so a subscription made with an older key can't linger.
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    await sb.from("push_subscriptions").delete().eq("endpoint", existing.endpoint);
    await existing.unsubscribe();
  }

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyToBytes(publicKey),
  });
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) throw new Error("The phone returned an incomplete subscription.");

  const { error: saveError } = await sb
    .from("push_subscriptions")
    .upsert({ endpoint: json.endpoint, p256dh, auth, user_agent: navigator.userAgent }, { onConflict: "endpoint" });
  if (saveError) {
    await subscription.unsubscribe();
    throw saveError;
  }
}

export async function disablePush(sb: SupabaseClient): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await sb.from("push_subscriptions").delete().eq("endpoint", subscription.endpoint);
  await subscription.unsubscribe();
}
