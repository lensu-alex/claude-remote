"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { getSupabase, isConfigured } from "@/lib/supabase";
import { deviceState } from "@/lib/format";
import { registerServiceWorker } from "@/lib/push";
import { parseSettings, type AppSettings } from "@/lib/settings";
import { reloadIfOutdated } from "@/lib/version";
import type { Device, Health, Usage } from "@/lib/types";
import { Mark } from "./Icons";

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

type SessionValue = { session: Session | null; ready: boolean };
const SessionContext = createContext<SessionValue>({ session: null, ready: false });
export const useSession = () => useContext(SessionContext);

// ---------------------------------------------------------------------------
// Laptops
// ---------------------------------------------------------------------------

type DevicesValue = {
  devices: Device[];
  loaded: boolean;
  /** The laptop marked active, whether or not it is answering. */
  active: Device | null;
  /** True when the active laptop checked in during the last minute. */
  activeOn: boolean;
  /** Ticks every few seconds so "on/offline" and relative times stay current. */
  now: number;
  /** Battery and power state per laptop id, as last reported by its helper. */
  health: Record<string, Health>;
  /** How much of the Claude plan's limits is used, as last reported during a task. */
  usage: Usage | null;
};
const DevicesContext = createContext<DevicesValue>({
  devices: [],
  loaded: false,
  active: null,
  activeOn: false,
  now: 0,
  health: {},
  usage: null,
});
export const useDevices = () => useContext(DevicesContext);

/** Runs `fn` whenever the page comes back: tab shown again, or the network returns. */
export function useOnWake(fn: () => void) {
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") fn();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", fn);
    window.addEventListener("pageshow", fn);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", fn);
      window.removeEventListener("pageshow", fn);
    };
  }, [fn]);
}

function DevicesProvider({ children }: { children: ReactNode }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [settings, setSettings] = useState<AppSettings>({ health: {}, usage: null });
  const settingsAt = useRef(0);

  // app_settings has no live updates: fetch on load, on wake, and at most once a minute while open.
  const loadSettings = useCallback(async (minGapMs: number) => {
    if (Date.now() - settingsAt.current < minGapMs) return;
    settingsAt.current = Date.now();
    const { data, error } = await getSupabase().from("app_settings").select("key, value");
    if (!error && data) setSettings(parseSettings(data as { key: string; value: unknown }[]));
  }, []);

  const load = useCallback(async () => {
    void loadSettings(5_000);
    const { data, error } = await getSupabase().from("devices").select("*").order("name");
    if (!error && data) {
      setDevices(data as Device[]);
      setLoaded(true);
    }
    setNow(Date.now());
  }, [loadSettings]);

  useEffect(() => {
    const sb = getSupabase();
    const channel = sb
      .channel("devices")
      .on("postgres_changes", { event: "*", schema: "public", table: "devices" }, (payload) => {
        setNow(Date.now());
        if (payload.eventType === "DELETE") {
          const gone = (payload.old as { id?: string }).id;
          setDevices((list) => list.filter((d) => d.id !== gone));
          return;
        }
        const row = payload.new as Device;
        setDevices((list) =>
          list.some((d) => d.id === row.id) ? list.map((d) => (d.id === row.id ? row : d)) : [...list, row],
        );
      })
      .subscribe((status) => {
        // Also covers reconnects: anything missed while the socket was down is fetched again.
        if (status === "SUBSCRIBED") void load();
      });
    // Load straight away too: the banner must not depend on the live connection coming up.
    void load();
    const tick = setInterval(() => {
      setNow(Date.now());
      if (document.visibilityState === "visible") void loadSettings(60_000);
    }, 10_000);
    return () => {
      clearInterval(tick);
      void sb.removeChannel(channel);
    };
  }, [load, loadSettings]);

  useOnWake(load);

  const value = useMemo<DevicesValue>(() => {
    const flagged = devices.filter((d) => d.active);
    // If two rows are briefly flagged during a switch, prefer the one that is answering.
    const active = flagged.find((d) => deviceState(d, now) === "on") ?? flagged[0] ?? null;
    return {
      devices,
      loaded,
      active,
      activeOn: active ? deviceState(active, now) === "on" : false,
      now,
      health: settings.health,
      usage: settings.usage,
    };
  }, [devices, loaded, now, settings]);

  return <DevicesContext.Provider value={value}>{children}</DevicesContext.Provider>;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

function NotConfigured() {
  return (
    <main className="center-screen">
      <div className="login">
        <Mark size={76} />
        <h1 className="login-title">Not Set Up Yet</h1>
        <p className="login-sub">This site doesn&apos;t know which database to talk to. It needs two values.</p>
        <div className="group login-fields">
          <div className="cell">
            <div className="cell-body">
              <code className="cell-title cell-code">NEXT_PUBLIC_SUPABASE_URL</code>
            </div>
          </div>
          <div className="cell">
            <div className="cell-body">
              <code className="cell-title cell-code">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>
            </div>
          </div>
        </div>
        <p className="group-footer">
          Run <code>remote setup</code> on the laptop to write them to <code>web/.env.local</code>, or add them in the
          Vercel project settings, then build the site again.
        </p>
      </div>
    </main>
  );
}

function Splash() {
  return (
    <main className="center-screen" aria-busy="true">
      <div className="splash">
        <Mark size={76} />
      </div>
    </main>
  );
}

function SessionGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const onLogin = pathname === "/login";

  useEffect(() => {
    const sb = getSupabase();
    void sb.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = sb.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setReady(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (!session && !onLogin) router.replace("/login");
    if (session && onLogin) router.replace("/");
  }, [ready, session, onLogin, router]);

  // iOS only applies :active (pressed) styles when something listens for touches.
  useEffect(() => {
    const noop = () => {};
    document.addEventListener("touchstart", noop, { passive: true });
    return () => document.removeEventListener("touchstart", noop);
  }, []);

  // Coming back to the app, or moving to another screen, picks up a newer version of the app
  // if one has been deployed meanwhile.
  useOnWake(reloadIfOutdated);
  useEffect(() => {
    void reloadIfOutdated();
  }, [pathname]);

  // Keep the service worker registered, and follow notification taps to the right chat.
  useEffect(() => {
    void registerServiceWorker();
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | null;
      if (data?.type === "navigate" && typeof data.url === "string" && data.url.startsWith("/")) router.push(data.url);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [router]);

  const value = useMemo(() => ({ session, ready }), [session, ready]);
  const userId = session?.user.id;

  return (
    <SessionContext.Provider value={value}>
      {onLogin ? children : ready && userId ? <DevicesProvider key={userId}>{children}</DevicesProvider> : <Splash />}
    </SessionContext.Provider>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  if (!isConfigured) return <NotConfigured />;
  return <SessionGate>{children}</SessionGate>;
}
