"use client";

import { useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { errorMessage, setKeepAwake, stopAll } from "@/lib/actions";
import { agoPhrase, countdown, lastSeenPhrase } from "@/lib/format";
import type { Health, Usage, UsageWindow } from "@/lib/types";
import { useDevices, useSession } from "./Providers";
import { Alert, Bolt, Laptop } from "./Icons";
import { Presence, Sheet } from "./Sheet";

const STALE_USAGE_MS = 30 * 60_000;
const LOW_BATTERY = 20;

type Tone = "green" | "blue" | "orange" | "red";

const RING = 2 * Math.PI * 27;

/** A ring gauge with its number in the middle, like the ones in Apple's Batteries widget. */
function Gauge({
  value,
  tone,
  label,
  note,
  charging = false,
  spoken,
}: {
  value: number;
  tone: Tone;
  label: string;
  note: string;
  charging?: boolean;
  spoken: string;
}) {
  const percent = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className={`gauge gauge-${tone}`} role="img" aria-label={spoken}>
      <div className="gauge-ring">
        <svg viewBox="0 0 64 64" aria-hidden="true">
          <circle className="gauge-track" cx="32" cy="32" r="27" />
          {percent > 0 ? (
            <circle className="gauge-value" cx="32" cy="32" r="27" strokeDasharray={`${(percent / 100) * RING} ${RING}`} />
          ) : null}
        </svg>
        {charging ? (
          <span className="gauge-bolt">
            <Bolt size={14} />
          </span>
        ) : null}
        <span className="gauge-number">
          {percent}
          <small>%</small>
        </span>
      </div>
      <span className="gauge-label">{label}</span>
      <span className="gauge-note">{note}</span>
    </div>
  );
}

function BatteryGauge({ health }: { health: Health }) {
  if (health.battery === null) return null;
  const low = !health.plugged && health.battery <= LOW_BATTERY;
  const note = health.charging ? "Charging" : health.plugged ? "Plugged in" : "On battery";
  return (
    <Gauge
      value={health.battery}
      tone={low ? "orange" : "green"}
      label="Battery"
      note={note}
      charging={health.charging}
      spoken={`Battery ${health.battery}%, ${note.toLowerCase()}`}
    />
  );
}

function UsageGauge({ label, window: win, limited, now }: { label: string; window: UsageWindow; limited: boolean; now: number }) {
  // A window whose reset time has passed has started again from zero.
  const reset = win.resets_at !== null && new Date(win.resets_at).getTime() <= now;
  const percent = Math.round((reset ? 0 : win.used) * 100);
  const left = countdown(win.resets_at, now);
  const full = limited && percent >= 99;
  const note = full ? "Limit reached" : reset ? "Has reset" : left ? `Resets in ${left}` : "";
  return (
    <Gauge
      value={percent}
      tone={percent >= 90 ? "red" : percent >= 75 ? "orange" : "blue"}
      label={label}
      note={note}
      spoken={`${label}: ${percent}% used${note ? `, ${note.toLowerCase()}` : ""}`}
    />
  );
}

/**
 * Top of Home: the laptop the phone is talking to, at a glance.
 * `running` and `waiting` count the tasks in those states; "Stop all tasks" is offered when there are any.
 */
export function LaptopCard({ running: runningTasks, waiting }: { running: number; waiting: number }) {
  const busy = runningTasks + waiting;
  const { active, activeOn, loaded, now, health, usage } = useDevices();
  const { session } = useSession();
  const [confirm, setConfirm] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The stay-awake switch: what was just tapped, until the account's saved preference catches up.
  const [awakeTapped, setAwakeTapped] = useState<boolean | null>(null);
  const [confirmSleep, setConfirmSleep] = useState(false);
  const [awakeError, setAwakeError] = useState<string | null>(null);

  async function keepAwake(on: boolean) {
    if (!active) return;
    setAwakeTapped(on);
    setAwakeError(null);
    setConfirmSleep(false);
    try {
      await setKeepAwake(getSupabase(), active.id, on);
    } catch (err) {
      setAwakeError(errorMessage(err));
    } finally {
      setAwakeTapped(null);
    }
  }

  async function stopEverything() {
    setStopping(true);
    setError(null);
    try {
      await stopAll(getSupabase());
      setConfirm(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setStopping(false);
    }
  }

  if (!loaded) return <div className="group lap-loading" aria-hidden="true" />;

  const state = !active ? "off" : activeOn ? "on" : "silent";
  const mine = active ? (health[active.id] ?? null) : null;
  const lowBattery = Boolean(mine && mine.battery !== null && !mine.plugged && mine.battery <= LOW_BATTERY);
  const running = active?.running ?? 0;
  const stale = Boolean(usage && usage.updated_at !== null && now - new Date(usage.updated_at).getTime() > STALE_USAGE_MS);

  // The name is the title; a short state sits under it as a label, and anything longer is a sentence below.
  const title = active ? active.name : "No laptop is on";
  const status = !active
    ? null
    : activeOn
      ? running === 0
        ? "On and ready"
        : running === 1
          ? "On, 1 task running"
          : `On, ${running} tasks running`
      : "Not answering";

  // Saved in the account's preferences, per laptop; on unless it was turned off.
  const saved = (session?.user.user_metadata?.keep_awake as Record<string, boolean> | undefined)?.[active?.id ?? ""];
  const awakeOn = awakeTapped ?? saved !== false;
  // Only a helper new enough to obey the switch gets one.
  const hasAwakeSwitch = Boolean(active && mine && mine.version >= 2);

  const hasGauges = Boolean((mine && mine.battery !== null) || usage?.five_hour || usage?.seven_day);

  return (
    <section className="group lap" aria-label="Laptop">
      <div className="lap-head">
        <span className={state === "on" ? "tile tile-blue" : "tile tile-gray"}>
          <Laptop size={18} />
        </span>
        <div className="lap-text">
          <strong>{title}</strong>
          {status ? (
            <span className="lap-status">
              <i className={`status-dot status-${state}`} aria-hidden="true" />
              {status}
            </span>
          ) : null}
        </div>
      </div>

      {state === "silent" && active ? (
        <p className="lap-detail">It may be asleep or offline, {lastSeenPhrase(active.last_seen, now)}.</p>
      ) : null}
      {state === "off" ? (
        <p className="lap-detail">
          Run <code>remote on</code> on a laptop. Tasks you start now wait for it.
        </p>
      ) : null}

      {hasGauges ? (
        <div className="gauges">
          {/* The spectrum the usage rings are drawn in; the colours come from the stylesheet. */}
          <svg className="gauge-defs" width="0" height="0" aria-hidden="true">
            <defs>
              <linearGradient id="gauge-iris" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="var(--iris-1)" />
                <stop offset="0.55" stopColor="var(--iris-2)" />
                <stop offset="1" stopColor="var(--iris-3)" />
              </linearGradient>
            </defs>
          </svg>
          {mine ? <BatteryGauge health={mine} /> : null}
          {usage?.five_hour ? <UsageGauge label="5-hour limit" window={usage.five_hour} limited={usage.limited} now={now} /> : null}
          {usage?.seven_day ? <UsageGauge label="Weekly limit" window={usage.seven_day} limited={usage.limited} now={now} /> : null}
        </div>
      ) : null}

      {lowBattery && mine ? (
        <p className="lap-note lap-note-warn" role="status">
          <Alert size={16} />
          Battery is at {mine.battery}% and the charger isn&apos;t connected.
        </p>
      ) : null}
      {stale && usage ? <p className="lap-note">Usage as of {agoPhrase(usage.updated_at, now)}</p> : null}

      {hasAwakeSwitch && mine ? (
        <>
          <label className="lap-row">
            <span className="lap-row-text">
              <strong>Stay awake</strong>
              <span>
                {!awakeOn
                  ? "It may go to sleep. Asleep, it takes no tasks."
                  : mine.awakeLow
                    ? "Battery under 10%: allowed to sleep until it charges."
                    : "It won\u2019t sleep on its own while the lid is open."}
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={awakeOn}
              disabled={awakeTapped !== null}
              onChange={() => (awakeOn ? setConfirmSleep(true) : void keepAwake(true))}
            />
          </label>
          {awakeError ? (
            <p className="lap-detail form-error" role="alert">
              {awakeError}
            </p>
          ) : null}
        </>
      ) : null}

      {busy > 0 ? (
        <button type="button" className="lap-stop" onClick={() => setConfirm(true)}>
          {busy === 1 ? "Stop the task" : "Stop all tasks"}
        </button>
      ) : null}

      <Presence>
        {confirm ? (
          <Sheet title={busy === 1 ? "Stop the task?" : `Stop all ${busy} tasks?`} onClose={() => setConfirm(false)}>
            <p className="sheet-text">
              Claude stops where it is, and anything waiting to run is cancelled. Changes already made on the laptop stay.
            </p>
            {error ? (
              <p className="sheet-text form-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="sheet-buttons">
              <button type="button" className="button button-destructive" onClick={() => void stopEverything()} disabled={stopping}>
                {stopping ? "Stopping…" : busy === 1 ? "Stop Task" : "Stop All"}
              </button>
              <button type="button" className="button" onClick={() => setConfirm(false)}>
                Cancel
              </button>
            </div>
          </Sheet>
        ) : null}
      </Presence>

      <Presence>
        {confirmSleep && active ? (
          <Sheet title={`Let ${active.name} sleep?`} onClose={() => setConfirmSleep(false)}>
            <p className="sheet-text">
              Once it goes to sleep it stops taking tasks, and it can&apos;t be woken from the phone. Someone has to open
              it or press a key. Tasks running when it sleeps pick up again when it wakes.
            </p>
            <div className="sheet-buttons">
              <button type="button" className="button" onClick={() => void keepAwake(false)}>
                Let It Sleep
              </button>
              <button type="button" className="button button-tint" onClick={() => setConfirmSleep(false)}>
                Keep It Awake
              </button>
            </div>
          </Sheet>
        ) : null}
      </Presence>
    </section>
  );
}
