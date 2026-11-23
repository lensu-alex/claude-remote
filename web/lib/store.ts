// Small things remembered on this phone only: unsent drafts and recently used folders.
// Storage can be missing or full (private mode, quota), so every call is allowed to fail quietly.

import type { RunChoice } from "./types";

export function readStore<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeStore(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Nothing useful to do: the draft just won't survive a reload.
  }
}

export function removeStore(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {}
}

export const draftKey = (id: string) => `cr:draft:${id}`;

export function saveDraft(id: string, text: string): void {
  if (text) writeStore(draftKey(id), text);
  else removeStore(draftKey(id));
}

export function loadDraft(id: string): string {
  const value = readStore<unknown>(draftKey(id), "");
  return typeof value === "string" ? value : "";
}

const FOLDERS_KEY = "cr:folders";
/** The home folder is stored as an empty string. */
export function recentFolders(): string[] {
  const value = readStore<unknown>(FOLDERS_KEY, []);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, 6) : [];
}

export function rememberFolder(path: string): void {
  writeStore(FOLDERS_KEY, [path, ...recentFolders().filter((p) => p !== path)].slice(0, 6));
}

// The model and effort picked for a chat ("new" for the next new task). Empty means the laptop's own setting.
const runKey = (id: string) => `cr:run:${id}`;

export function loadRun(id: string): RunChoice {
  const value = readStore<unknown>(runKey(id), null);
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  if (typeof value !== "object" || value === null) return { model: "", effort: "" };
  const { model, effort } = value as Record<string, unknown>;
  return { model: text(model), effort: text(effort) };
}

export function saveRun(id: string, run: RunChoice): void {
  if (run.model || run.effort) writeStore(runKey(id), run);
  else removeStore(runKey(id));
}
