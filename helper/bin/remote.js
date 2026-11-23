#!/usr/bin/env node
// The `remote` command: set up this laptop, turn it on or off, and check on it.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, DIR, LOG_FILE, connect, loadConfig, runningPid, saveConfig } from '../src/config.js';

const SELF = fileURLToPath(import.meta.url);
const PROJECT = path.resolve(path.dirname(SELF), '..', '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const HELP = `remote: control Claude on this laptop from your phone

  remote setup     connect this laptop to your account (run once per laptop)
  remote on        make this laptop the active one and start taking tasks
  remote off       stop taking tasks on this laptop
  remote status    show which laptop is on
  remote logs      show recent helper activity (add -f to follow)
  remote notify    send a test notification to your phone
  remote send      show a picture or file in the chat on the phone
                   (remote send <file>... [--caption "text"]; used by Claude during a task)
`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function requireConfig() {
  const config = loadConfig();
  if (!config) fail('This laptop is not set up yet. Run: remote setup');
  return config;
}

function ago(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function tailLog(lines = 15) {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

// --- setup ----------------------------------------------------------------

function prompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  let muted = false;
  const write = rl._writeToOutput?.bind(rl);
  if (write) rl._writeToOutput = (text) => (muted ? undefined : write(text));
  const buffered = [];
  const waiting = [];
  rl.on('line', (line) => (waiting.length ? waiting.shift()(line) : buffered.push(line)));
  rl.on('close', () => waiting.forEach((resolve) => resolve('')));
  return {
    async ask(question, { hidden = false, fallback = '' } = {}) {
      process.stdout.write(fallback ? `${question} [${fallback}]: ` : `${question}: `);
      muted = hidden;
      const answer = buffered.length ? buffered.shift() : await new Promise((resolve) => waiting.push(resolve));
      muted = false;
      if (hidden) process.stdout.write('\n');
      return answer.trim() || fallback;
    },
    close: () => rl.close(),
  };
}

async function setup() {
  const previous = loadConfig() ?? {};
  const p = prompter();
  console.log('Connect this laptop to your Supabase project.');
  console.log('Find these in the Supabase dashboard under Project Settings > API Keys (and Data API for the URL).\n');

  // Keep only https://xxxx.supabase.co; the dashboard also shows longer forms such as .../rest/v1/.
  let supabaseUrl;
  try {
    const parsed = new URL(await p.ask('Project URL (https://xxxx.supabase.co)', { fallback: previous.supabaseUrl }));
    if (parsed.protocol !== 'https:') throw new Error('not https');
    supabaseUrl = parsed.origin;
  } catch {
    fail('That does not look like a project URL. It should look like https://xxxx.supabase.co');
  }
  const publicKey = await p.ask('Publishable key (also called anon key)', { fallback: previous.publicKey });
  const secretKey =
    (await p.ask(`Secret key (also called service_role key; typing is hidden)${previous.secretKey ? ' [keep current]' : ''}`, { hidden: true })) ||
    previous.secretKey;
  if (!publicKey || !secretKey) fail('Both keys are needed.');
  if (publicKey === secretKey) fail('The publishable key and the secret key must be different.');

  const config = { ...previous, supabaseUrl, publicKey, secretKey };
  const db = connect(config);

  const probe = await db.from('devices').select('id').limit(1);
  if (probe.error) {
    fail(
      `\nCould not read the database: ${probe.error.message}\n` +
        `If the tables do not exist yet, paste ${path.join(PROJECT, 'supabase', 'schema.sql')} into the Supabase SQL Editor, run it, and try again.`,
    );
  }

  const users = await db.auth.admin.listUsers({ page: 1, perPage: 10 });
  if (users.error) fail(`\nThe secret key was not accepted: ${users.error.message}`);
  let owner = users.data.users[0];
  if (owner) {
    console.log(`\nAccount: ${owner.email}`);
  } else {
    console.log('\nNo account exists yet. Create yours; it will be the only one, and sign-ups stay closed.');
    const email = await p.ask('Email');
    const password = await p.ask('Password (at least 12 characters; typing is hidden)', { hidden: true });
    if (password.length < 12) fail('Use at least 12 characters. This password is the lock on your laptop.');
    const again = await p.ask('Password again', { hidden: true });
    if (password !== again) fail('The passwords did not match.');
    const created = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error) fail(`Could not create the account: ${created.error.message}`);
    owner = created.data.user;
    console.log(`Account created: ${owner.email}`);
  }

  const defaultName = previous.deviceName || os.hostname().replace(/\.local$/, '');
  config.deviceName = await p.ask('\nName for this laptop', { fallback: defaultName });
  p.close();

  config.deviceId = previous.deviceId || randomUUID();
  config.ownerId = owner.id;
  config.ownerEmail = owner.email;

  const { ensurePushKeys } = await import('../src/push.js');
  await ensurePushKeys(db);

  const device = await db.from('devices').upsert({
    id: config.deviceId,
    user_id: config.ownerId,
    name: config.deviceName,
    platform: process.platform,
    home: os.homedir(),
  });
  if (device.error) fail(`Could not register this laptop: ${device.error.message}`);

  saveConfig(config);
  console.log(`\nSaved ${CONFIG_FILE}`);

  // The website only ever gets the two public values.
  const web = path.join(PROJECT, 'web');
  if (fs.existsSync(web)) {
    fs.writeFileSync(
      path.join(web, '.env.local'),
      `NEXT_PUBLIC_SUPABASE_URL=${supabaseUrl}\nNEXT_PUBLIC_SUPABASE_ANON_KEY=${publicKey}\n`,
    );
    console.log(`Saved ${path.join(web, '.env.local')}`);
  }
  console.log('\nDone. Turn this laptop on with: remote on');
}

// --- on / off / status / logs ---------------------------------------------

async function on() {
  requireConfig();
  const existing = runningPid();
  if (existing) return console.log(`Already on (process ${existing}). Check with: remote status`);

  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  // Keep the activity log from growing forever: past 5 MB, keep only the newest part.
  try {
    if (fs.statSync(LOG_FILE).size > 5_000_000) {
      const text = fs.readFileSync(LOG_FILE, 'utf8');
      fs.writeFileSync(LOG_FILE, text.slice(-1_000_000).replace(/^[^\n]*\n/, ''));
    }
  } catch {}
  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [SELF, 'run'], { detached: true, stdio: ['ignore', out, out] });
  child.unref();

  // Give it a moment to connect, and report honestly if it died.
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    if (runningPid() === child.pid && /\bon: /.test(tailLog(5))) {
      console.log('On. This laptop is now the active one. It stays awake while this is running, unless Stay awake is off in the app.');
      console.log('Keep the lid open and the charger connected. Turn off with: remote off');
      return;
    }
    try {
      process.kill(child.pid, 0);
    } catch {
      fail(`The helper stopped right after starting:\n${tailLog(8)}`);
    }
  }
  console.log(`Started (process ${child.pid}), but it has not confirmed yet. Check with: remote logs`);
}

async function off() {
  const config = requireConfig();
  const pid = runningPid();
  if (pid) {
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 60 && runningPid(); i++) await sleep(500);
    if (runningPid()) fail(`The helper (process ${pid}) is still shutting down. Check with: remote logs`);
    return console.log('Off. This laptop no longer takes tasks.');
  }
  // Not running here; make sure the phone does not still show it as on.
  const { error } = await connect(config).from('devices').update({ active: false, running: 0 }).eq('id', config.deviceId);
  console.log(error ? `Already off here, but the database could not be updated: ${error.message}` : 'Already off.');
}

async function status() {
  const config = requireConfig();
  const pid = runningPid();
  console.log(`This laptop (${config.deviceName}): helper ${pid ? `on (process ${pid})` : 'off'}`);
  const { data, error } = await connect(config).from('devices').select('*').order('name');
  if (error) fail(`Could not reach the database: ${error.message}`);
  console.log('');
  for (const d of data) {
    const fresh = d.last_seen && Date.now() - new Date(d.last_seen).getTime() < 60_000;
    const state = d.active ? (fresh ? 'ON' : 'on, but not responding') : 'off';
    const tasks = d.active && d.running ? `, ${d.running} task${d.running === 1 ? '' : 's'} running` : '';
    console.log(`  ${d.name}${d.id === config.deviceId ? ' (this one)' : ''}: ${state}${tasks}, last seen ${ago(d.last_seen)}`);
  }
}

async function notify() {
  const config = requireConfig();
  const db = connect(config);
  const { data, error } = await db.from('push_subscriptions').select('id');
  if (error) fail(`Could not reach the database: ${error.message}`);
  if (!data.length) {
    return console.log(
      'No phone has notifications turned on yet.\n' +
        'On the iPhone: open the site from its Home Screen icon, go to Settings, and tap "Turn on notifications".',
    );
  }
  const { createPusher } = await import('../src/push.js');
  const problems = [];
  await createPusher(db, config, (...args) => problems.push(args.join(' '))).notify({
    title: 'Claude Remote',
    body: `Test from ${config.deviceName}. Notifications are working.`,
    url: '/',
  });
  const left = await db.from('push_subscriptions').select('id');
  if (problems.length) console.log(`Problem sending: ${problems.join('; ')}`);
  else if ((left.data?.length ?? 0) < data.length) console.log('The phone has dropped its subscription. Turn notifications on again in the site\'s Settings.');
  else console.log(`Sent to ${data.length} device${data.length === 1 ? '' : 's'}. It should appear on the phone within a few seconds.`);
}

/** `remote send <file>... [--caption "text"] [--chat <id>]`: Claude runs this to show the owner something. */
async function send(args) {
  const config = requireConfig();
  const paths = [];
  let caption = '';
  let chat = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--caption') caption = args[++i] ?? '';
    else if (args[i] === '--chat') chat = args[++i] ?? '';
    else paths.push(args[i]);
  }
  const { findConversation, sendFiles } = await import('../src/files.js');
  const db = connect(config);
  const conversationId = await findConversation(db, config, chat);
  const sent = await sendFiles(db, config, { conversationId, paths, caption });
  for (const file of sent) console.log(`Sent ${file.name} (${Math.max(1, Math.round(file.size / 1000))} KB). It now shows in the chat on the phone.`);
}

function logs(follow) {
  if (!fs.existsSync(LOG_FILE)) return console.log('No activity yet.');
  if (follow) return spawn('tail', ['-n', '40', '-f', LOG_FILE], { stdio: 'inherit' });
  console.log(tailLog(40));
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'setup') await setup();
  else if (command === 'on') await on();
  else if (command === 'off') await off();
  else if (command === 'status') await status();
  else if (command === 'logs') logs(rest.includes('-f'));
  else if (command === 'notify') await notify();
  else if (command === 'send') await send(rest);
  else if (command === 'run') await (await import('../src/daemon.js')).startDaemon();
  else console.log(HELP);
} catch (err) {
  fail(err.message);
}
