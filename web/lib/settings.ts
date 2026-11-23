import type { Health, Usage, UsageWindow } from "./types";

// app_settings values are free-form JSON written by the helper, so read them defensively.

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isoOrNull = (value: unknown) => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null);

export function parseHealth(value: unknown): Health | null {
  if (!isObject(value)) return null;
  const battery = typeof value.battery === "number" ? Math.max(0, Math.min(100, Math.round(value.battery))) : null;
  return {
    battery,
    plugged: value.plugged === true,
    charging: value.charging === true,
    updated_at: isoOrNull(value.updated_at),
    version: typeof value.v === "number" ? value.v : 0,
    // A helper that predates the switch always keeps the laptop awake.
    awake: value.awake !== false,
    awakeWanted: value.awake_wanted !== false,
    awakeLow: value.awake_low === true,
  };
}

function parseWindow(value: unknown): UsageWindow | null {
  if (!isObject(value) || typeof value.used !== "number") return null;
  return { used: Math.max(0, Math.min(1, value.used)), resets_at: isoOrNull(value.resets_at) };
}

export function parseUsage(value: unknown): Usage | null {
  if (!isObject(value)) return null;
  const five_hour = parseWindow(value.five_hour);
  const seven_day = parseWindow(value.seven_day);
  if (!five_hour && !seven_day) return null;
  return { five_hour, seven_day, limited: value.limited === true, updated_at: isoOrNull(value.updated_at) };
}

export type AppSettings = { health: Record<string, Health>; usage: Usage | null };

export function parseSettings(rows: { key: string; value: unknown }[]): AppSettings {
  const out: AppSettings = { health: {}, usage: null };
  for (const row of rows) {
    if (row.key === "usage") out.usage = parseUsage(row.value);
    else if (row.key.startsWith("health:")) {
      const health = parseHealth(row.value);
      if (health) out.health[row.key.slice("health:".length)] = health;
    }
  }
  return out;
}
