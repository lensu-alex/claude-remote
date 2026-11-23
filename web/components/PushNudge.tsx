"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { errorMessage } from "@/lib/actions";
import { currentSubscription, enablePush, pushSupport } from "@/lib/push";
import { Bell } from "./Icons";
import { Presence, Sheet } from "./Sheet";

type State = "hidden" | "off" | "needs-home-screen";

/**
 * One row on Home while this phone cannot receive notifications.
 * There is no way to dismiss it for good: it goes away when notifications work.
 */
export function PushNudge() {
  const [state, setState] = useState<State>("hidden");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [explain, setExplain] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const support = pushSupport();
      // A browser that cannot do push at all has nothing to turn on, so say nothing.
      if (support === "unsupported") return;
      if (support === "needs-home-screen") {
        if (!cancelled) setState("needs-home-screen");
        return;
      }
      const subscription = await currentSubscription().catch(() => null);
      const on = Boolean(subscription) && Notification.permission === "granted";
      if (!cancelled) setState(on ? "hidden" : "off");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function turnOn() {
    if (state === "needs-home-screen") {
      setExplain(true);
      return;
    }
    setWorking(true);
    setError(null);
    try {
      await enablePush(getSupabase());
      setState("hidden");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setWorking(false);
    }
  }

  if (state === "hidden") return null;

  return (
    <>
      <div className="group nudge">
        <div className="cell">
          <span className="tile tile-red">
            <Bell size={18} />
          </span>
          <div className="cell-body">
            <span className="cell-title">Notifications are off</span>
            <button type="button" className="pill-button" onClick={() => void turnOn()} disabled={working}>
              {working ? "Turning On…" : "Turn On"}
            </button>
          </div>
        </div>
      </div>
      {error ? (
        <p className="group-footer form-error" role="alert">
          {error}
        </p>
      ) : null}
      <Presence>
        {explain ? (
          <Sheet title="Add to Home Screen first" onClose={() => setExplain(false)}>
            <p className="sheet-text">
              On iPhone, a website can only send notifications once it is on the Home Screen. In Safari, tap the Share
              button, choose Add to Home Screen, then open Claude Remote from its new icon and tap Turn On again.
            </p>
            <div className="sheet-buttons">
              <button type="button" className="button" onClick={() => setExplain(false)}>
                OK
              </button>
            </div>
          </Sheet>
        ) : null}
      </Presence>
    </>
  );
}
