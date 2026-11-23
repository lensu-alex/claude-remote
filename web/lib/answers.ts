// One-tap answers. When Claude ends a reply by asking something with a few obvious answers, it
// lists them (see helper/rules.md) and the chat offers each as a button.

import type { EventRow } from "./types";

const LINE = /\n?[ \t]*\[\[\s*answers\s*:([^\]\n]*)\]\][ \t]*$/i;

function clean(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 60).slice(0, 4);
}

/**
 * The laptop's helper normally takes the answers line out of the text. This does the same for
 * a reply recorded by a helper that did not, so the line is never shown as text.
 */
export function splitAnswers(text: string): { text: string; answers: string[] } {
  const source = text.trimEnd();
  const match = source.match(LINE);
  if (!match || match.index === undefined) return { text, answers: [] };
  return { text: source.slice(0, match.index).trimEnd(), answers: clean(match[1].split("|").map((a) => a.trim())) };
}

/** The answers on offer right now: those of Claude's last reply, as long as nothing was sent after it. */
export function pendingAnswers(events: EventRow[]): string[] {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.kind === "user" || e.kind === "error") return [];
    if (e.kind === "result") {
      const given = clean(e.body.answers);
      if (given.length > 0) return given;
    }
    if (e.kind === "text") {
      const given = clean(e.body.answers);
      return given.length > 0 ? given : splitAnswers(typeof e.body.text === "string" ? e.body.text : "").answers;
    }
  }
  return [];
}
