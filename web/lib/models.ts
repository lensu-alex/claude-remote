// The choices offered for a message's model and effort. The values are what the laptop passes to
// Claude Code (`--model`, `--effort`); an empty value leaves it to the laptop's own setting.

import type { RunChoice } from "./types";

export type Option = { value: string; label: string; note?: string };

export const MODELS: Option[] = [
  { value: "", label: "Default", note: "What the laptop is set to" },
  { value: "fable", label: "Fable" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

export const EFFORTS: Option[] = [
  { value: "", label: "Default", note: "What the laptop is set to" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];

const labelOf = (options: Option[], value: string) => options.find((o) => o.value === value)?.label ?? value;

export const modelLabel = (value: string) => labelOf(MODELS, value);
export const effortLabel = (value: string) => labelOf(EFFORTS, value);

/** "Opus, high effort", "Opus", "High effort", or "Default" when nothing was chosen. */
export function runLabel(run: RunChoice): string {
  const parts = [];
  if (run.model) parts.push(modelLabel(run.model));
  if (run.effort) parts.push(`${effortLabel(run.effort)} effort`);
  if (parts.length === 0) return "Default";
  return parts.length === 2 ? `${parts[0]}, ${parts[1].toLowerCase()}` : parts[0];
}
