"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { errorMessage } from "@/lib/actions";
import { clearCache } from "@/lib/cache";
import { BUILD_TIME } from "@/lib/version";
import { deviceState, lastSeenPhrase } from "@/lib/format";
import { currentSubscription, disablePush, enablePush, pushSupport, type PushSupport } from "@/lib/push";
import { useDevices, useSession } from "@/components/Providers";
import { Screen, TabBar, TopBar } from "@/components/Chrome";
import { Bell, Laptop, Person } from "@/components/Icons";

type PushState = "checking" | "on" | "off" | PushSupport;

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export default function SettingsPage() {
  const { session } = useSession();
  const { devices, loaded, now } = useDevices();
  const [push, setPush] = useState<PushState>("checking");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const support = pushSupport();
      if (support !== "ok") {
        if (!cancelled) setPush(support);
        return;
      }
      const subscription = await currentSubscription();
      const on = Boolean(subscription) && Notification.permission === "granted";
      if (!cancelled) setPush(on ? "on" : "off");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function turnOn() {
    setWorking(true);
    setError(null);
    try {
      await enablePush(getSupabase());
      setPush("on");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setWorking(false);
    }
  }

  async function turnOff() {
    setWorking(true);
    setError(null);
    try {
      await disablePush(getSupabase());
      setPush("off");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setWorking(false);
    }
  }

  function signOut() {
    clearCache();
    void getSupabase().auth.signOut();
  }

  const canToggle = push === "on" || push === "off";
  // Set after mounting: the phone's own time zone decides how the build time reads.
  const [version, setVersion] = useState("");
  useEffect(() => {
    if (!BUILD_TIME) return;
    setVersion(new Date(BUILD_TIME).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }));
  }, []);

  return (
    <Screen>
      <TopBar title="Settings" large />

      <main className="content content-tabbed">
        <h1 className="large-title">Settings</h1>

        <section>
          <div className="group">
            <label className="cell">
              <span className="tile tile-red">
                <Bell size={18} />
              </span>
              <div className="cell-body">
                <span className="cell-title">Notifications</span>
                {canToggle ? (
                  <input
                    type="checkbox"
                    role="switch"
                    className="switch"
                    checked={push === "on"}
                    disabled={working}
                    onChange={() => void (push === "on" ? turnOff() : turnOn())}
                  />
                ) : (
                  <span className="cell-detail">{push === "checking" ? "Checking…" : "Unavailable"}</span>
                )}
              </div>
            </label>
          </div>
          {push === "needs-home-screen" ? (
            <p className="group-footer">
              On iPhone, notifications only work for sites opened from the Home Screen. In Safari, tap the Share button,
              choose Add to Home Screen, then open Claude Remote from its new icon and come back here.
            </p>
          ) : push === "unsupported" ? (
            <p className="group-footer">This browser can&apos;t receive notifications from websites.</p>
          ) : push === "checking" ? null : (
            <p className="group-footer">
              {push === "on" ? "This device gets" : "Get"} a notification when a task finishes or fails, when Claude asks
              you a question, and when the laptop&apos;s battery runs low.
            </p>
          )}
          {error ? (
            <p className="group-footer form-error" role="alert">
              {error}
            </p>
          ) : null}
        </section>

        <section>
          <h2 className="group-header">Laptops</h2>
          <div className="group">
            {!loaded ? (
              <div className="cell">
                <div className="cell-body">
                  <span className="cell-detail">Loading…</span>
                </div>
              </div>
            ) : devices.length === 0 ? (
              <div className="cell">
                <div className="cell-body">
                  <span className="cell-title">No laptop is set up yet</span>
                </div>
              </div>
            ) : (
              devices.map((device) => {
                const state = deviceState(device, now);
                return (
                  <div key={device.id} className="cell">
                    <span className={state === "on" ? "tile tile-blue" : "tile tile-gray"}>
                      <Laptop size={18} />
                    </span>
                    <div className="cell-body">
                      <div className="cell-stack">
                        <span className="cell-title">{device.name}</span>
                        <span className="cell-sub">
                          {state === "on"
                            ? device.running > 0
                              ? device.running === 1
                                ? "1 task running"
                                : `${device.running} tasks running`
                              : "Ready"
                            : sentence(lastSeenPhrase(device.last_seen, now))}
                        </span>
                      </div>
                      <span className={`cell-detail cell-state-${state}`}>
                        {state === "on" ? "On" : state === "silent" ? "Not answering" : "Off"}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          {loaded && devices.length === 0 ? (
            <p className="group-footer">
              Run <code>remote setup</code> on a laptop to add it.
            </p>
          ) : (
            <p className="group-footer">
              Only one laptop is on at a time. To switch, run <code>remote on</code> on the other one.
            </p>
          )}
        </section>

        <section>
          <h2 className="group-header">Account</h2>
          <div className="group">
            <div className="cell">
              <span className="tile tile-gray">
                <Person size={18} />
              </span>
              <div className="cell-body">
                <span className="cell-title cell-title-clip">{session?.user.email ?? ""}</span>
              </div>
            </div>
            <button type="button" className="cell cell-link cell-destructive" onClick={signOut}>
              <div className="cell-body">
                <span className="cell-title">Sign Out</span>
              </div>
            </button>
          </div>
          {version ? <p className="group-footer">Version from {version}. New versions load when you come back to the app.</p> : null}
        </section>
      </main>

      <TabBar current="settings" />
    </Screen>
  );
}
