import type { Device, Folder } from "./types";

// A laptop counts as on when it is the active one and checked in under a minute ago.
export const ONLINE_WINDOW_MS = 60_000;

export type DeviceState = "on" | "silent" | "off";

export function deviceState(device: Device, now: number): DeviceState {
  if (!device.active) return "off";
  if (!device.last_seen) return "silent";
  return now - new Date(device.last_seen).getTime() < ONLINE_WINDOW_MS ? "on" : "silent";
}

export function relativeTime(iso: string | null, now: number): string {
  if (!iso) return "";
  const then = new Date(iso);
  const seconds = Math.max(0, Math.round((now - then.getTime()) / 1000));
  if (seconds < 45) return "now";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  if (seconds < 7 * 86_400) return then.toLocaleDateString(undefined, { weekday: "short" });
  return then.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function lastSeenPhrase(iso: string | null, now: number): string {
  if (!iso) return "never checked in";
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 90) return "last seen a minute ago";
  if (seconds < 3600) return `last seen ${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `last seen ${Math.round(seconds / 3600)} h ago`;
  return `last seen ${Math.round(seconds / 86_400)} d ago`;
}

export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${Math.max(1, seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function folderLabel(cwd: string | null, folders: Folder[] = []): string {
  if (!cwd) return "Home folder";
  const known = folders.find((f) => f.path === cwd);
  if (known) return known.label;
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function titleFrom(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  if (flat.length <= 60) return flat || "New task";
  const cut = flat.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return `${(space > 30 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Time left until `iso`, such as "2h 10m" or "3d 4h". Empty when it has passed. */
export function countdown(iso: string | null, now: number): string {
  if (!iso) return "";
  const minutes = Math.round((new Date(iso).getTime() - now) / 60_000);
  if (minutes <= 0) return "";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** How long something has been going, to the minute: "under 1m", "12m", "1h 4m". */
export function elapsed(iso: string | null, now: number): string {
  if (!iso) return "";
  const minutes = Math.floor(Math.max(0, now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "under 1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function agoPhrase(iso: string | null, now: number): string {
  if (!iso) return "";
  const minutes = Math.round(Math.max(0, now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

/** A file's size the way Files shows it: "840 KB", "2.4 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}
