// Where the helper keeps its settings on this laptop.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

export const DIR = process.env.CLAUDE_REMOTE_HOME || path.join(os.homedir(), '.config', 'claude-remote');
export const CONFIG_FILE = path.join(DIR, 'config.json');
export const PID_FILE = path.join(DIR, 'helper.pid');
export const LOG_FILE = path.join(DIR, 'helper.log');

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function saveConfig(config) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  // The secret key is in here, so the file is readable by this user only.
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(CONFIG_FILE, 0o600);
}

export function connect(config) {
  return createClient(config.supabaseUrl, config.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** PID of the running helper on this laptop, or null. */
export function runningPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (!pid) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** Folders offered in the phone's folder picker: home, a few standard ones, and each project in ~/Developer. */
export function listFolders(extra = []) {
  const home = os.homedir();
  const folders = [];
  const add = (dir) => {
    try {
      if (!fs.statSync(dir).isDirectory()) return;
    } catch {
      return;
    }
    if (folders.some((f) => f.path === dir)) return;
    const rel = path.relative(home, dir);
    folders.push({ path: dir, label: rel === '' ? 'Home' : rel.startsWith('..') ? dir : rel });
  };

  add(home);
  for (const parent of ['Developer', 'Projects', 'Code']) {
    const dir = path.join(home, parent);
    add(dir);
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) add(path.join(dir, entry.name));
      }
    } catch {}
  }
  for (const name of ['Desktop', 'Documents', 'Downloads']) add(path.join(home, name));
  for (const dir of extra) add(dir);
  return folders;
}
