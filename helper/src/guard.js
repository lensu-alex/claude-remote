#!/usr/bin/env node
// Safety net for remote sessions, run by Claude Code as a PreToolUse hook before every shell command.
// It refuses a short list of catastrophic commands. It is a backstop, not a guarantee:
// rules.md is what tells Claude how to behave, this only catches the worst slips.

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WRAPPERS = new Set(['sudo', 'command', 'nohup', 'time', 'exec', 'doas']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'fish']);
const POWER = new Set(['shutdown', 'reboot', 'halt', 'poweroff']);

function tokenize(segment) {
  const tokens = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

// Split on ; && || | and newlines, but not inside quotes.
function segments(command) {
  const out = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

function expand(target, home) {
  return target
    .replace(/^~(?=\/|$)/, home)
    .replace(/\$\{HOME\}|\$HOME\b/g, home);
}

function isProtected(abs, home) {
  const parent = path.dirname(abs);
  return (
    abs === '/' ||
    abs === home ||
    parent === '/' ||
    parent === home ||
    parent === '/Users' ||
    parent === '/home' ||
    parent === path.join(home, 'Library')
  );
}

function resolveTarget(target, cwd, home) {
  // "dir/*" and "dir/.*" remove everything in dir, so judge them as dir itself.
  const stripped = expand(target, home).replace(/\/\.?\*$/, '') || '/';
  return path.resolve(cwd, stripped === '*' ? '.' : stripped);
}

function gitToplevel(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function checkSegment(segment, cwd, home) {
  let tokens = tokenize(segment);
  while (tokens.length && (WRAPPERS.has(tokens[0]) || /^\w+=/.test(tokens[0]))) tokens = tokens.slice(1);
  if (!tokens.length) return null;
  const cmd = path.basename(tokens[0]);
  const args = tokens.slice(1);

  if (SHELLS.has(cmd)) {
    const i = args.indexOf('-c');
    if (i !== -1 && args[i + 1]) return check(args[i + 1], cwd, home);
    return null;
  }

  if (POWER.has(cmd)) return 'it would turn off or restart the laptop, which cuts the owner off';
  if (cmd === 'systemctl' && args.some((a) => /^(poweroff|reboot|halt|suspend|hibernate)$/.test(a)))
    return 'it would turn off or suspend the laptop, which cuts the owner off';
  if (cmd === 'pmset' && args.includes('sleepnow')) return 'it would put the laptop to sleep, which cuts the owner off';
  if (cmd === 'osascript' && /shut ?down|restart|sleep|log ?out/i.test(args.join(' ')))
    return 'it looks like it would shut down, restart, sleep, or log out the laptop';
  if (cmd === 'remote' && args[0] === 'off') return 'it would stop the remote helper and end this task';

  if (/^mkfs/.test(cmd)) return 'it would format a disk';
  if (cmd === 'diskutil' && args.some((a) => /^(erase|partitionDisk|zeroDisk|randomDisk|secureErase|reformat)/i.test(a)))
    return 'it would erase a disk';
  if (cmd === 'diskutil' && args[0] === 'apfs' && /^delete/i.test(args[1] ?? '')) return 'it would delete a disk volume';
  if (cmd === 'dd' && args.some((a) => /^of=\/dev\//.test(a))) return 'it would overwrite a disk device';

  if (cmd === 'rm') {
    const flags = args.filter((a) => a.startsWith('-') && a !== '--');
    const recursive = flags.some((f) => f === '--recursive' || /^-[a-zA-Z]*[rR]/.test(f));
    if (!recursive) return null;
    for (const target of args.filter((a) => !a.startsWith('-'))) {
      const expanded = expand(target, home);
      if (/^\$\{?\w+\}?(\/\.?\*?)?$/.test(expanded))
        return `"${target}" is an unexpanded variable; if it were empty this would delete from the root`;
      const abs = resolveTarget(target, cwd, home);
      if (isProtected(abs, home)) return `it would recursively delete ${abs}, a top-level or system folder`;
    }
    return null;
  }

  if (cmd === 'find' && (args.includes('-delete') || (args.includes('-exec') && args.includes('rm')))) {
    const roots = [];
    for (const a of args) {
      if (a.startsWith('-') || a === '(' || a === '!') break;
      roots.push(a);
    }
    for (const root of roots.length ? roots : ['.']) {
      const abs = resolveTarget(root, cwd, home);
      if (isProtected(abs, home)) return `it would delete files across ${abs}, a top-level or system folder`;
    }
    return null;
  }

  if (cmd === 'git' && args.includes('clean') && args.some((a) => /^-[a-zA-Z]*f/.test(a) || a === '--force')) {
    const c = args.indexOf('-C');
    const dir = c !== -1 && args[c + 1] ? path.resolve(cwd, expand(args[c + 1], home)) : cwd;
    const top = gitToplevel(dir);
    if (top && (top === home || top === '/'))
      return `this folder is not its own git repository (the repository root is ${top}), so "git clean" would delete every file here`;
    return null;
  }

  return null;
}

/** Returns a reason string when the command must be refused, otherwise null. */
export function check(command, cwd = process.cwd(), home = os.homedir()) {
  for (const segment of segments(String(command ?? ''))) {
    const reason = checkSegment(segment, cwd, home);
    if (reason) return reason;
  }
  return null;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  if (input.tool_name !== 'Bash') process.exit(0);
  const reason = check(input.tool_input?.command, input.cwd || process.cwd());
  if (!reason) process.exit(0);
  // Exit code 2 blocks the tool call; stderr is shown to Claude.
  process.stderr.write(
    `Blocked by the remote safety net: ${reason}. ` +
      'Do not look for another way to do the same thing. ' +
      'If it is really needed, narrow it to specific files you created, use the trash instead, ' +
      'or end your turn and ask the owner.\n',
  );
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
