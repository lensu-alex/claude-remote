"use client";

import { memo, useState } from "react";
import { splitAnswers } from "@/lib/answers";
import { asText, duration, fileSize } from "@/lib/format";
import { runLabel } from "@/lib/models";
import type { Attachment, EventRow, SentFile } from "@/lib/types";
import { SentImages } from "./Attachments";
import { Alert, Check, ChevronRight, Close, Doc, Download } from "./Icons";
import { Markdown } from "./Markdown";

export type Step = { tool: EventRow; result?: EventRow };
export type Block = { kind: "steps"; key: string; steps: Step[] } | { kind: "event"; key: string; event: EventRow };

const text = (value: unknown) => (typeof value === "string" ? value : "");

function images(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    .map((v) => ({ name: text(v.name) || "Photo", type: text(v.type), thumb: text(v.thumb) || undefined }));
}

/** Files Claude sent to the chat. Only https links are kept: the address is opened when tapped. */
function sentFiles(value: unknown): SentFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    .filter((v) => text(v.url).startsWith("https://"))
    .map((v) => ({
      name: text(v.name) || "File",
      type: text(v.type),
      size: typeof v.size === "number" ? v.size : 0,
      url: text(v.url),
      image: v.image === true,
      preview: text(v.preview).startsWith("https://") ? text(v.preview) : undefined,
    }));
}

/** Pictures show in the chat and open full size when tapped; anything else is a row that downloads. */
function Files({ files }: { files: SentFile[] }) {
  if (files.length === 0) return null;
  return (
    <ul className="files">
      {files.map((file) => (
        <li key={file.url}>
          {file.image ? (
            <a className="file-image" href={file.url} target="_blank" rel="noreferrer noopener" aria-label={`Open ${file.name}`}>
              {/* eslint-disable-next-line @next/next/no-img-element -- a signed address from the owner's storage, not a site asset */}
              <img src={file.preview ?? file.url} alt={file.name} loading="lazy" />
            </a>
          ) : (
            <a className="file" href={file.url} target="_blank" rel="noreferrer noopener" download={file.name}>
              <span className="tile tile-blue">
                <Doc size={18} />
              </span>
              <span className="file-text">
                <span className="file-name">{file.name}</span>
                <span className="file-size">{fileSize(file.size)}</span>
              </span>
              <Download size={20} className="file-get" />
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Pairs each tool call with its result and gathers runs of tool calls into one block. */
export function buildBlocks(events: EventRow[]): Block[] {
  const results = new Map<string, EventRow>();
  const toolIds = new Set<string>();
  for (const e of events) {
    if (e.kind === "tool" && text(e.body.id)) toolIds.add(text(e.body.id));
    if (e.kind === "tool_result" && text(e.body.tool_id)) results.set(text(e.body.tool_id), e);
  }

  const blocks: Block[] = [];
  for (const e of events) {
    if (e.kind === "tool_result" && toolIds.has(text(e.body.tool_id))) continue; // shown inside its tool row
    if (e.kind === "tool") {
      const step: Step = { tool: e, result: results.get(text(e.body.id)) };
      const last = blocks[blocks.length - 1];
      if (last?.kind === "steps") last.steps.push(step);
      else blocks.push({ kind: "steps", key: `steps-${e.id}`, steps: [step] });
      continue;
    }
    blocks.push({ kind: "event", key: `event-${e.id}`, event: e });
  }
  return blocks;
}

function ToolStep({ step, working }: { step: Step; working: boolean }) {
  const [open, setOpen] = useState(false);
  const { tool, result } = step;
  const failed = result?.body.is_error === true;
  const output = text(result?.body.text);
  const hasInput = tool.body.input !== undefined && tool.body.input !== null;

  return (
    <div className={open ? "step is-open" : "step"}>
      <button type="button" className="step-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="step-mark" aria-hidden="true">
          {result ? (
            failed ? (
              <Close size={14} className="glyph-red" />
            ) : (
              <Check size={14} className="glyph-quiet" />
            )
          ) : working ? (
            <i className="spinner spinner-small" />
          ) : null}
        </span>
        <span className="step-name">{text(tool.body.name) || "Tool"}</span>
        <span className="step-summary">{text(tool.body.summary)}</span>
        <ChevronRight size={12} className="disclosure" />
      </button>
      {open ? (
        <div className="step-body">
          {hasInput ? (
            <>
              <div className="step-label">Input</div>
              <pre className="output">{asText(tool.body.input)}</pre>
            </>
          ) : null}
          <div className="step-label">{failed ? "Error" : "Result"}</div>
          {result ? (
            <pre className={failed ? "output output-error" : "output"}>{output || "(no output)"}</pre>
          ) : (
            <p className="step-empty">{working ? "Still running…" : "No result was recorded."}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Tool names in the order first used: "Read, Edit, Bash…". */
function toolNames(steps: Step[]): string {
  const names: string[] = [];
  for (const step of steps) {
    const name = text(step.tool.body.name) || "Tool";
    if (!names.includes(name)) names.push(name);
  }
  return names.length > 3 ? `${names.slice(0, 3).join(", ")}…` : names.join(", ");
}

/**
 * A run of tool calls. Finished runs fold into one quiet line so the chat reads as a conversation;
 * the run Claude is in right now shows its latest step.
 */
function StepGroup({ steps, live }: { steps: Step[]; live: boolean }) {
  const [open, setOpen] = useState(false);

  if (steps.length === 1) {
    return (
      <div className="activity">
        <div className="steps">
          <ToolStep step={steps[0]} working={live} />
        </div>
      </div>
    );
  }

  const failures = steps.filter((s) => s.result?.body.is_error === true).length;
  const latest = steps[steps.length - 1];

  return (
    <div className={open ? "activity is-open" : "activity"}>
      <button type="button" className="activity-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ChevronRight size={12} className="disclosure" />
        <span className="activity-count">{steps.length} steps</span>
        <span className="activity-names">{toolNames(steps)}</span>
        {failures > 0 ? <span className="activity-failed">{failures === 1 ? "1 failed" : `${failures} failed`}</span> : null}
      </button>
      {open ? (
        <div className="steps">
          {steps.map((step) => (
            <ToolStep key={step.tool.id} step={step} working={live} />
          ))}
        </div>
      ) : live ? (
        <div className="steps">
          <ToolStep key={latest.tool.id} step={latest} working />
        </div>
      ) : null}
    </div>
  );
}

function EventItem({ event, queued }: { event: EventRow; queued: boolean }) {
  const body = event.body;
  switch (event.kind) {
    case "user": {
      const photos = images(body.images);
      const message = text(body.text);
      return (
        <div className={event.state === "cancelled" ? "msg-user is-cancelled" : "msg-user"}>
          <SentImages images={photos} />
          {message ? <div className="bubble">{message}</div> : null}
          {event.state === "pending" ? <span className="msg-note">{queued ? "Queued, runs next" : "Waiting for laptop"}</span> : null}
          {event.state === "cancelled" ? <span className="msg-note">Not run</span> : null}
        </div>
      );
    }
    case "text": {
      const words = splitAnswers(text(body.text)).text;
      return (
        <div className="msg-claude">
          {words.trim() ? <Markdown text={words} /> : null}
          <Files files={sentFiles(body.files)} />
        </div>
      );
    }
    case "tool_result":
      // Only reached when the matching tool row is missing (for example, outside the loaded window).
      return (
        <div className="activity">
          <pre className={body.is_error === true ? "output output-error" : "output"}>{text(body.text) || "(no output)"}</pre>
        </div>
      );
    case "result": {
      const ms = typeof body.duration_ms === "number" ? body.duration_ms : null;
      const ok = body.ok !== false;
      const ran = { model: text(body.model), effort: text(body.effort) };
      return (
        <div className="note">
          {ok ? "Finished" : "Ended"}
          {ms !== null ? ` ${ok ? "in" : "after"} ${duration(ms)}` : ""}
          {ran.model || ran.effort ? ` · ${runLabel(ran)}` : ""}
        </div>
      );
    }
    case "error": {
      const limit = body.limit === true;
      return (
        <div className={limit ? "callout callout-limit" : "callout callout-error"} role="alert">
          <Alert size={20} />
          <div>
            <strong>{limit ? "Usage limit reached" : "Something went wrong"}</strong>
            {limit ? (
              <p>Claude stopped because the plan&apos;s usage limit was hit. Send a message to continue once it resets.</p>
            ) : null}
            {text(body.text) ? <p className="callout-detail">{text(body.text)}</p> : null}
          </div>
        </div>
      );
    }
    case "notice":
      return <div className="note">{text(body.text)}</div>;
    default:
      return null;
  }
}

/** The id of the event a block starts with, which is when the block first appeared. */
export function blockFirstId(block: Block): number {
  return block.kind === "steps" ? block.steps[0].tool.id : block.event.id;
}

/**
 * `live` is true only for the last block while the task is running.
 * `queued` is true while another message is being worked on, so a pending one is waiting its turn.
 * `fresh` is true for a block that arrived while the chat was open, so it eases in.
 */
export const TimelineBlock = memo(function TimelineBlock({
  block,
  live,
  queued,
  fresh = false,
}: {
  block: Block;
  live: boolean;
  queued: boolean;
  fresh?: boolean;
}) {
  return (
    <div className={fresh ? "block is-fresh" : "block"}>
      {block.kind === "steps" ? <StepGroup steps={block.steps} live={live} /> : <EventItem event={block.event} queued={queued} />}
    </div>
  );
});
