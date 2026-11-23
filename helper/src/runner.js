// Runs one turn of Claude Code in headless mode and turns its output stream
// into the event rows described in supabase/schema.sql.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RULES_FILE = path.join(HERE, '..', 'rules.md');
const GUARD_FILE = path.join(HERE, 'guard.js');

const MAX_RESULT_CHARS = 6000;
const MAX_INPUT_STRING_CHARS = 2000;
const LIMIT_RE = /usage limit|rate limit|limit reached|limit will reset|out of (extra )?usage/i;

export function clip(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${s.slice(0, head)}\n… ${s.length - max} characters hidden …\n${s.slice(-tail)}`;
}

function clipInput(value) {
  if (typeof value === 'string') return clip(value, MAX_INPUT_STRING_CHARS);
  if (Array.isArray(value)) return value.slice(0, 50).map(clipInput);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipInput(v)]));
  return value;
}

function shortPath(file, cwd) {
  if (!file) return '';
  const rel = path.relative(cwd, file);
  return rel && !rel.startsWith('..') ? rel : file;
}

/** One short line describing a tool call, for the collapsed view on the phone. */
export function summarize(name, input = {}, cwd = '/') {
  const oneLine = (s) => clip(String(s ?? '').split('\n')[0].trim(), 140);
  switch (name) {
    case 'Bash':
      return oneLine(input.description || input.command);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return shortPath(input.file_path || input.notebook_path, cwd);
    case 'Grep':
    case 'Glob':
      return oneLine(input.pattern);
    case 'WebFetch':
      return oneLine(input.url);
    case 'WebSearch':
      return oneLine(input.query);
    case 'Agent':
    case 'Task':
      return oneLine(input.description);
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string' && v.trim());
      return first ? oneLine(first) : '';
    }
  }
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const ANSWERS_RE = /\n?[ \t]*\[\[\s*answers\s*:([^\]\n]*)\]\][ \t]*$/i;

/** The model the owner picked for a message: an alias such as "opus" or a full model name. Anything else is ignored. */
export function cleanModel(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9.[\]-]{1,60}$/i.test(value) ? value : null;
}

/** The effort level the owner picked for a message, or null to leave it to the laptop's own setting. */
export function cleanEffort(value) {
  return EFFORTS.includes(value) ? value : null;
}

/**
 * Claude may end a reply with a last line such as `[[answers: Yes | No | Only the first]]`
 * (see rules.md). Those become one-tap buttons on the phone; the line itself is not shown.
 */
export function splitAnswers(text) {
  const source = String(text ?? '').trimEnd();
  const match = source.match(ANSWERS_RE);
  if (!match) return { text: String(text ?? ''), answers: [] };
  const answers = match[1]
    .split('|')
    .map((a) => a.trim())
    .filter((a) => a && a.length <= 60)
    .slice(0, 4);
  return { text: source.slice(0, match.index).trimEnd(), answers };
}

/** True when Claude ended its turn by asking the owner something. */
export function endsWithQuestion(text) {
  const last = String(text ?? '').trim().split('\n').pop() ?? '';
  return /\?$/.test(last.replace(/[\s*_`)"'”]+$/, ''));
}

/** The plan's usage windows, from the limit report Claude emits during a task. */
export function toUsage(info) {
  if (!info || typeof info !== 'object') return null;
  const window = (w) =>
    w && typeof w.utilization === 'number'
      ? { used: w.utilization, resets_at: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null }
      : undefined;
  const windows = info.unifiedWindows ?? {};
  const usage = { limited: info.status === 'rejected' };
  const five = window(windows.five_hour);
  const seven = window(windows.seven_day);
  if (five) usage.five_hour = five;
  if (seven) usage.seven_day = seven;
  return five || seven || usage.limited ? usage : null;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part?.type === 'text' ? part.text : part?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Converts one parsed line of `claude -p --output-format stream-json` into
 * { events, sessionId?, final? }. `final` is set on the closing result line.
 */
export function normalize(msg, cwd = '/') {
  const out = { events: [] };
  if (!msg || typeof msg !== 'object') return out;

  if (msg.type === 'system' && msg.subtype === 'init') {
    out.sessionId = msg.session_id;
    return out;
  }

  if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
    out.events.push({ kind: 'notice', body: { text: 'Claude summarized the earlier part of this chat to make room for more.' } });
    return out;
  }

  if (msg.type === 'rate_limit_event') {
    const usage = toUsage(msg.rate_limit_info);
    if (usage) out.usage = usage;
    return out;
  }

  // Steps taken inside a sub-agent would flood the timeline; the parent's own steps are enough.
  if (msg.parent_tool_use_id) return out;

  if (msg.type === 'assistant') {
    for (const block of msg.message?.content ?? []) {
      if (block.type === 'text' && block.text?.trim()) {
        const { text, answers } = splitAnswers(block.text);
        if (text.trim()) out.events.push({ kind: 'text', body: answers.length ? { text, answers } : { text } });
      } else if (block.type === 'tool_use') {
        out.events.push({
          kind: 'tool',
          body: {
            id: block.id,
            name: block.name,
            summary: summarize(block.name, block.input, cwd),
            input: clipInput(block.input ?? {}),
          },
        });
      }
    }
    return out;
  }

  if (msg.type === 'user') {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return out;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      out.events.push({
        kind: 'tool_result',
        body: {
          tool_id: block.tool_use_id,
          text: clip(resultText(block.content), MAX_RESULT_CHARS),
          is_error: Boolean(block.is_error),
        },
      });
    }
    return out;
  }

  if (msg.type === 'result') {
    const { text, answers } = splitAnswers(typeof msg.result === 'string' ? msg.result : '');
    const ok = !msg.is_error && msg.subtype === 'success';
    // Offering answers is asking, even when the wording has no question mark.
    const question = ok && (endsWithQuestion(text) || answers.length > 0);
    out.final = { ok, text, limit: !ok && LIMIT_RE.test(text), question };
    if (ok) {
      const body = { ok: true, duration_ms: msg.duration_ms ?? null, turns: msg.num_turns ?? null, question };
      if (answers.length) body.answers = answers;
      out.events.push({ kind: 'result', body });
    } else {
      out.events.push({
        kind: 'error',
        body: { text: text || `Claude stopped (${msg.subtype ?? 'error'}).`, limit: out.final.limit },
      });
    }
    return out;
  }

  return out;
}

/** Settings passed to every remote session: the safety-net hook on shell commands. */
export function guardSettings() {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `"${process.execPath}" "${GUARD_FILE}"` }],
        },
      ],
    },
  });
}

function childEnv(conversationId) {
  const env = { ...process.env, CLAUDE_REMOTE: '1' };
  // Lets `remote send` (run by Claude to show the owner a file) know which chat it belongs to.
  if (conversationId) env.CLAUDE_REMOTE_CONVERSATION = conversationId;
  // Remote tasks must run on the logged-in plan, never silently on a pay-per-use key.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

/**
 * Starts one turn. `sessionId` is the Claude session to create (resume=false) or continue (resume=true).
 * `model` and `effort` are the owner's choice for this message; without them the laptop's own settings apply.
 * `onTurnEnd(final)` fires each time Claude finishes a reply; the process can outlive that.
 * Returns { child, stop(), done } where done resolves when the process exits, to
 * { ok, text, limit, question, stopped, sawResult }.
 */
export function runClaude({
  claudePath = 'claude',
  prompt,
  cwd,
  sessionId,
  resume,
  model,
  effort,
  conversationId,
  onEvents,
  onSession,
  onUsage,
  onTurnEnd,
}) {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--append-system-prompt-file', RULES_FILE,
    '--settings', guardSettings(),
    resume ? '--resume' : '--session-id', sessionId,
  ];
  if (cleanModel(model)) args.push('--model', model);
  if (cleanEffort(effort)) args.push('--effort', effort);

  // Own process group, so Stop also reaches whatever Claude has running.
  const child = spawn(claudePath, args, { cwd, env: childEnv(conversationId), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);

  let stopped = false;
  let final = null;
  let stderrTail = '';
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });

  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const { events, sessionId: sid, final: f, usage } = normalize(msg, cwd);
    if (sid) onSession?.(sid);
    if (usage) onUsage?.(usage);
    if (f) final = f;
    // After Stop, Claude's closing line reports an error; the helper's own "Stopped" notice says it better.
    const visible = stopped ? events.filter((e) => e.kind !== 'error' && e.kind !== 'result') : events;
    if (visible.length) onEvents?.(visible);
    // Claude has replied. The process itself may stay alive if it left something running in the background.
    if (f && !stopped) onTurnEnd?.(f);
  });

  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
    } catch {
      try {
        child.kill(name);
      } catch {}
    }
  };

  const done = new Promise((resolve) => {
    let spawnError = null;
    child.on('error', (err) => {
      spawnError = err;
    });
    child.on('close', (code) => {
      if (final && !stopped) return resolve({ ...final, stopped: false, sawResult: true });
      if (stopped) return resolve({ ok: false, text: '', limit: false, stopped: true, sawResult: Boolean(final) });
      const detail = spawnError?.message || stderrTail.trim().split('\n').slice(-3).join('\n');
      const text = `Claude stopped unexpectedly (exit code ${code ?? 'unknown'}).${detail ? `\n${detail}` : ''}`;
      onEvents?.([{ kind: 'error', body: { text, limit: LIMIT_RE.test(detail) } }]);
      resolve({ ok: false, text, limit: LIMIT_RE.test(detail), stopped: false, sawResult: false });
    });
  });

  return {
    child,
    done,
    stop() {
      if (stopped) return;
      stopped = true;
      signal('SIGINT');
      setTimeout(() => child.exitCode === null && signal('SIGTERM'), 5000).unref();
      setTimeout(() => child.exitCode === null && signal('SIGKILL'), 10000).unref();
    },
  };
}
