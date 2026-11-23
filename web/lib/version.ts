// The build this copy of the app came from. Both values are fixed when the site is built (next.config.ts).

/** Differs for every deployment; the same everywhere within one. "local" when not built by Vercel. */
export const BUILD_ID = process.env.BUILD_ID ?? "local";
/** When the build was made, for showing in Settings. */
export const BUILD_TIME = process.env.BUILD_TIME ?? "";

const RELOADED_FOR = "cr:reloaded-for";
const MIN_GAP_MS = 20_000;
let lastCheck = 0;

/**
 * A phone keeps the app open for days, so a new version would never load on its own.
 * Called when the app comes back to the front, when moving between screens, and when a reply
 * arrives in an open chat: if the site has moved on, reload into it.
 * Never while a text field is in use, and only once per new build, so a mismatch that
 * a reload doesn't cure cannot turn into a loop.
 */
export async function reloadIfOutdated(): Promise<void> {
  if (document.visibilityState !== "visible" || Date.now() - lastCheck < MIN_GAP_MS) return;
  lastCheck = Date.now();
  try {
    const response = await fetch("/version", { cache: "no-store" });
    if (!response.ok) return;
    const { build } = (await response.json()) as { build?: unknown };
    if (typeof build !== "string" || build === BUILD_ID) return;
    if (window.sessionStorage.getItem(RELOADED_FOR) === build) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) {
      lastCheck = 0; // look again next time, once the typing is done
      return;
    }
    window.sessionStorage.setItem(RELOADED_FOR, build);
    window.location.reload();
  } catch {
    // Offline, or storage refused: the check simply runs again on the next return to the app.
  }
}
