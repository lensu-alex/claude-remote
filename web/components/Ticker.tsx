"use client";

import type { CSSProperties } from "react";
import type { UsageWindow } from "@/lib/types";
import { useDevices } from "./Providers";

// A line shorter than this is repeated until it is wider than any phone.
const MIN_LETTERS = 110;
const SECONDS_PER_LETTER = 0.26;

function used(win: UsageWindow, now: number) {
  // A window whose reset time has passed has started again from zero.
  const reset = win.resets_at !== null && new Date(win.resets_at).getTime() <= now;
  return Math.round((reset ? 0 : win.used) * 100);
}

/**
 * The band of running text at the top of Tasks: the laptop, its tasks and the plan's limits in one line.
 * It repeats what the card below says, so screen readers skip it.
 */
export function Ticker({ running, waiting }: { running: number; waiting: number }) {
  const { active, activeOn, loaded, now, health, usage } = useDevices();

  const items: string[] = [];
  if (loaded) {
    if (!active) {
      items.push("No laptop is on", "Tasks wait until one is");
    } else if (!activeOn) {
      items.push(`${active.name} isn’t answering`, "Tasks wait until it is back");
    } else {
      items.push(`${active.name} is on`);
      items.push(running === 0 ? "Nothing running" : running === 1 ? "1 task running" : `${running} tasks running`);
    }
    if (waiting > 0) items.push(`${waiting} waiting`);
    if (usage?.five_hour) items.push(`5-hour limit ${used(usage.five_hour, now)}%`);
    if (usage?.seven_day) items.push(`Weekly limit ${used(usage.seven_day, now)}%`);
    const battery = active ? health[active.id]?.battery : null;
    if (battery !== null && battery !== undefined) items.push(`Battery ${battery}%`);
  }

  let line = items;
  const letters = items.join("").length;
  if (letters > 0) for (let n = letters; n < MIN_LETTERS; n += letters) line = line.concat(items);
  const time = { "--ticker-time": `${Math.round(line.join("").length * SECONDS_PER_LETTER)}s` } as CSSProperties;

  const copy = (key: string) => (
    <div className="ticker-line" key={key}>
      {line.map((text, i) => (
        <span className="ticker-item" key={i}>
          {text}
          <svg width="9" height="8" viewBox="0 0 9 8" aria-hidden="true">
            <path d="M0 0h9L4.5 8z" fill="currentColor" />
          </svg>
        </span>
      ))}
    </div>
  );

  return (
    <div className="ticker" aria-hidden="true">
      <div className="ticker-track" style={time}>
        {copy("a")}
        {copy("b")}
      </div>
    </div>
  );
}
