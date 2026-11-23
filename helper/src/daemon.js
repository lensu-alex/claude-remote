// The long-running part of the helper: makes this laptop the active one,
// picks up messages sent from the phone, runs them with Claude Code, and writes the output back.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SLEEP_BELOW, batteryTooLow, createWakeLock } from './awake.js';
import { DIR, PID_FILE, connect, listFolders, loadConfig } from './config.js';
import { KEEP_FILES_DAYS, tidyFiles } from './files.js';
import { readHealth } from './health.js';
import { createPusher } from './push.js';
import { cleanEffort, cleanModel, clip, runClaude } from './runner.js';

const MAX_PARALLEL = 3;
const HEARTBEAT_MS = 15_000;
const POLL_MS = 3_000;
const FOLDERS_MS = 5 * 60_000;
const HEALTH_MS = 60_000;
const STEP_MS = 5_000;
const LINGER_GRACE_MS = 4_000;
const TIDY_MS = 24 * 60 * 60_000;
const KEEP_OUTPUT_DAYS = 30;
const USAGE_MS = 20_000;
const LOW_BATTERY = 20;
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 2_000_000;
const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
// What this helper can do, so the website only offers controls that will have an effect.
// 2: model and effort per message, files back from Claude, one-tap answers, the stay-awake switch.
const HELPER_VERSION = 2;

const log = (...args) => console.log(new Date().toISOString(), ...args);
const firstLine = (text) => clip(String(text ?? '').trim().split('\n').find((l) => l.trim()) ?? '', 160);
const lastLine = (text) => clip(String(text ?? '').trim().split('\n').pop() ?? '', 160);

function findClaude(config) {
  if (config.claudePath && fs.existsSync(config.claudePath)) return config.claudePath;
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('Claude Code is not installed or not on the PATH. Install it and run "claude" once to log in.');
  }
}

/** `deps` lets the tests swap in a fake database and a fake Claude; in normal use it is empty. */
export async function startDaemon(deps = {}) {
  const config = deps.config ?? loadConfig();
  if (!config) throw new Error('This laptop is not set up yet. Run: remote setup');

  const standalone = !deps.db;
  const db = deps.db ?? connect(config);
  const me = config.deviceId;
  const startRun = deps.runClaude ?? runClaude;
  const claudePath = deps.runClaude ? 'claude' : findClaude(config);
  const push = deps.push ?? createPusher(db, config, log);
  const exit = deps.exit ?? ((code) => process.exit(code));
  const health = deps.readHealth ?? readHealth;
  const uploads = deps.uploadDir ?? path.join(DIR, 'uploads');
  // Held for as long as the laptop should not sleep. The tests pass their own.
  const wakeLock = deps.wakeLock ?? (standalone ? createWakeLock(log) : null);
  const lingerGrace = deps.lingerGraceMs ?? LINGER_GRACE_MS;
  // conversation id -> job. A job is `active` while Claude is working on a reply. After the reply it can
  // linger, because Claude's process stays alive for as long as something it started in the background runs.
  const jobs = new Map();
  const activeCount = () => [...jobs.values()].filter((job) => job.active).length;
  let standingDown = false;
  let shuttingDown = false;
  let stopNotice = 'Stopped.';

  if (standalone) {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(PID_FILE, String(process.pid));
  }

  const addEvent = async (conversationId, kind, body, state = null) => {
    const { error } = await db
      .from('events')
      .insert({ conversation_id: conversationId, user_id: config.ownerId, kind, body, state });
    if (error) log('could not write event:', error.message);
  };

  // Keeps one conversation's rows in the order Claude produced them.
  const createWriter = (conversationId) => {
    let chain = Promise.resolve();
    return {
      push(events) {
        const rows = events.map((e) => ({
          conversation_id: conversationId,
          user_id: config.ownerId,
          kind: e.kind,
          body: e.body,
        }));
        chain = chain.then(async () => {
          const { error } = await db.from('events').insert(rows);
          if (error) log('could not write events:', error.message);
        });
      },
      flush: () => chain,
    };
  };

  // --- becoming the active laptop -----------------------------------------

  const others = await db.from('devices').update({ active: false }).neq('id', me);
  if (others.error) throw new Error(`Could not reach the database: ${others.error.message}`);
  const mine = await db.from('devices').upsert({
    id: me,
    user_id: config.ownerId,
    name: config.deviceName,
    platform: process.platform,
    home: os.homedir(),
    folders: listFolders(config.extraFolders),
    active: true,
    running: 0,
    last_seen: new Date().toISOString(),
  });
  if (mine.error) throw new Error(`Could not register this laptop: ${mine.error.message}`);

  // Tasks that were mid-run when the helper last died never finished; say so instead of leaving them spinning.
  const stale = await db.from('conversations').select('id').eq('device_id', me).eq('status', 'running');
  for (const conv of stale.data ?? []) {
    await db.from('events').update({ state: 'done' }).eq('conversation_id', conv.id).eq('state', 'running');
    await addEvent(conv.id, 'notice', { text: 'The helper restarted while this task was running, so it was cut off.' });
    await db.from('conversations').update({ status: 'error', stop_requested: false }).eq('id', conv.id);
  }

  const timers = [];
  log(`on: "${config.deviceName}" is the active laptop (claude: ${claudePath})`);

  // --- shutting down ------------------------------------------------------

  async function shutdown(reason, notice) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`turning off: ${reason}`);
    if (notice) stopNotice = notice;
    const running = [...jobs.values()];
    for (const job of running) job.run.stop();
    await Promise.allSettled(running.map((job) => job.finished));
    // If another laptop took over, `active` is already false and must stay with them.
    await db.from('devices').update({ active: false, running: 0 }).eq('id', me);
    wakeLock?.release();
    timers.forEach(clearInterval);
    if (standalone) {
      try {
        if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_FILE);
      } catch {}
    }
    exit(0);
  }

  function standDown() {
    if (standingDown || shuttingDown) return;
    standingDown = true;
    log('another laptop took over; finishing current tasks, taking no new ones');
    for (const job of jobs.values()) if (!job.active) job.run.stop();
    if (jobs.size === 0) shutdown('another laptop is active now');
  }

  if (standalone) {
    process.on('SIGTERM', () => shutdown('remote off', 'Stopped: this laptop was turned off.'));
    process.on('SIGINT', () => shutdown('interrupted', 'Stopped: this laptop was turned off.'));
    process.on('unhandledRejection', (err) => log('unexpected error:', err?.message ?? err));
  }

  // --- running tasks ------------------------------------------------------

  // Runs each time Claude finishes a reply, and once more if the process dies or is stopped mid-reply.
  async function endTurn(conv, ev, outcome, job) {
    const { writer, lastText } = job;
    job.active = false;
    job.turnEndedAt = Date.now();
    await writer.flush();
    await job.stepWrite;
    saveUsage(true);
    if (outcome.stopped) {
      await addEvent(conv.id, 'notice', { text: stopNotice });
      // Stop means stop everything queued behind it too.
      await db.from('events').update({ state: 'cancelled' }).eq('conversation_id', conv.id).eq('state', 'pending');
    }
    await db.from('events').update({ state: 'done' }).eq('id', ev.id);

    const patch = { status: outcome.ok || outcome.stopped ? 'idle' : 'error', stop_requested: false };
    // When Claude ended by asking something, the question is what the owner needs to see.
    const preview = outcome.question
      ? lastLine(outcome.text)
      : firstLine(outcome.ok ? outcome.text || lastText : outcome.text);
    if (preview) patch.last_text = preview;
    // A session that cannot be found again would fail forever; start a fresh one next time.
    if (!outcome.ok && /no conversation found/i.test(outcome.text)) patch.claude_session_id = null;
    await db.from('conversations').update(patch).eq('id', conv.id);
    log(`finished ${conv.id}: ${outcome.stopped ? 'stopped' : outcome.ok ? 'ok' : 'failed'}`);

    if (!outcome.stopped) {
      await push.notify({
        title: outcome.question ? `Question: ${conv.title}` : outcome.ok ? conv.title : `Needs attention: ${conv.title}`,
        body: outcome.limit ? 'Stopped: the usage limit was reached.' : preview || (outcome.ok ? 'Done.' : 'The task failed.'),
        url: `/c/${conv.id}`,
      });
    }

    reportRunning();
  }

  // Tells the owner when a reply left something running, since the chat otherwise looks finished.
  function noteLingering(conv, job) {
    setTimeout(() => {
      if (jobs.get(conv.id) !== job || job.active || job.ending || job.noted) return;
      job.noted = true;
      addEvent(conv.id, 'notice', {
        text: 'Something from this step is still running in the background on the laptop. It is stopped when you send your next message in this chat.',
      });
    }, Math.max(lingerGrace, 1000) + 1000).unref();
  }

  async function startJob(ev) {
    const { data: conv } = await db.from('conversations').select('*').eq('id', ev.conversation_id).maybeSingle();
    if (!conv || conv.stop_requested) return;

    const claim = await db.from('events').update({ state: 'running' }).eq('id', ev.id).eq('state', 'pending').select('id, body');
    if (!claim.data?.length) return;
    const body = claim.data[0].body ?? {};

    const refuse = async (text) => {
      await addEvent(conv.id, 'error', { text, limit: false });
      await db.from('events').update({ state: 'cancelled' }).eq('id', ev.id);
      await db.from('conversations').update({ status: 'error', last_text: text }).eq('id', conv.id);
    };

    if (conv.device_id && conv.device_id !== me) {
      return refuse('This chat lives on another laptop. Turn that laptop on to continue it, or start a new chat.');
    }
    const cwd = conv.cwd || os.homedir();
    if (!fs.existsSync(cwd)) return refuse(`The folder ${cwd} does not exist on this laptop.`);
    const images = await saveImages(conv.id, ev.id, body);
    const prompt = buildPrompt(String(body.text ?? '').trim(), images);
    if (!prompt) return refuse('The message was empty.');

    // The owner's choice for this message; without one the laptop's own Claude settings apply.
    const model = cleanModel(body.model);
    const effort = cleanEffort(body.effort);
    const resume = Boolean(conv.claude_session_id);
    const sessionId = conv.claude_session_id || randomUUID();
    // Clearing the preview keeps the previous reply from showing as this task's current step.
    await db.from('conversations').update({ device_id: me, status: 'running', last_text: null }).eq('id', conv.id);

    const job = {
      active: true,
      writer: createWriter(conv.id),
      lastText: '',
      stepWrite: Promise.resolve(),
      stepAt: 0,
      turns: Promise.resolve(), // bookkeeping for each reply, kept in order
    };
    const failed = (err) => log('task bookkeeping failed:', err.message);
    job.run = startRun({
      claudePath,
      prompt,
      cwd,
      sessionId,
      resume,
      model,
      effort,
      conversationId: conv.id,
      onEvents(events) {
        // Background work finished and Claude picked the chat back up on its own.
        if (!job.active && !job.ending && events.some((e) => e.kind === 'text' || e.kind === 'tool')) {
          job.active = true;
          job.turns = job.turns
            .then(() => db.from('conversations').update({ status: 'running', last_text: null }).eq('id', conv.id))
            .then(reportRunning, failed);
        }
        for (const e of events) {
          if (e.kind === 'text') job.lastText = e.body.text;
          if (e.kind === 'tool') showStep(conv.id, job, e.body);
          // The closing line of a reply says what it ran on, when the owner chose.
          if (e.kind === 'result' && (model || effort)) e.body = { ...e.body, ...(model && { model }), ...(effort && { effort }) };
        }
        job.writer.push(events);
      },
      onTurnEnd(final) {
        job.active = false;
        job.turns = job.turns
          .then(() => endTurn(conv, ev, { ...final, stopped: false }, job))
          .then(() => {
            noteLingering(conv, job);
            tick();
          }, failed);
      },
      onSession(sid) {
        if (!resume) db.from('conversations').update({ claude_session_id: sid }).eq('id', conv.id).then(() => {});
      },
      onUsage(usage) {
        latestUsage = usage;
        saveUsage(false);
      },
    });
    job.finished = job.run.done
      .then(async (outcome) => {
        await job.turns;
        // Still mid-reply means it crashed or was stopped; otherwise the reply was already recorded.
        if (job.active) await endTurn(conv, ev, outcome, job);
        else if (outcome.stopped && job.stopReason) await addEvent(conv.id, 'notice', { text: job.stopReason });
      })
      .catch(failed)
      .then(() => {
        jobs.delete(conv.id);
        if (standingDown && jobs.size === 0) return shutdown('another laptop is active now');
        reportRunning();
        tick();
      });
    jobs.set(conv.id, job);
    log(`started ${conv.id} in ${cwd}`);
    reportRunning();
  }

  // The task list on the phone shows what a running task is doing right now.
  function showStep(conversationId, job, tool) {
    if (Date.now() - job.stepAt < STEP_MS) return;
    job.stepAt = Date.now();
    const step = clip(`${tool.name}  ${tool.summary ?? ''}`.trim(), 160);
    job.stepWrite = job.stepWrite.then(() =>
      db.from('conversations').update({ last_text: step }).eq('id', conversationId).eq('status', 'running').then(() => {}),
    );
  }

  /** Writes photos sent from the phone to disk and drops their data from the database row. */
  async function saveImages(conversationId, eventId, body) {
    const incoming = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
    const saved = [];
    const kept = [];
    for (const [i, image] of incoming.entries()) {
      const { data, ...rest } = image ?? {};
      const ext = IMAGE_EXT[image?.type];
      if (typeof data !== 'string' || !ext) continue;
      const bytes = Buffer.from(data, 'base64');
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) continue;
      const dir = path.join(uploads, conversationId);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${eventId}-${i + 1}.${ext}`);
      fs.writeFileSync(file, bytes);
      saved.push(file);
      kept.push({ ...rest, saved: true });
    }
    if (incoming.length) {
      const { error } = await db.from('events').update({ body: { ...body, images: kept } }).eq('id', eventId);
      if (error) log('could not tidy images:', error.message);
    }
    return saved;
  }

  function buildPrompt(text, images) {
    if (!images.length) return text;
    const list = images.map((file) => `- ${file}`).join('\n');
    const count = images.length === 1 ? 'an image' : `${images.length} images`;
    const note = `The owner attached ${count} from their phone, saved on this laptop. Look at ${images.length === 1 ? 'it' : 'each one'} with the Read tool:\n${list}`;
    return text ? `${text}\n\n${note}` : `${note}\n\nThere is no message with ${images.length === 1 ? 'it' : 'them'}; respond to what you see.`;
  }

  async function handleStops() {
    const { data } = await db.from('conversations').select('id, device_id').eq('stop_requested', true);
    for (const conv of data ?? []) {
      const job = jobs.get(conv.id);
      if (job) {
        job.run.stop();
      } else if (!conv.device_id || conv.device_id === me) {
        // Nothing running here: cancel whatever was still waiting.
        const cancelled = await db
          .from('events')
          .update({ state: 'cancelled' })
          .eq('conversation_id', conv.id)
          .eq('state', 'pending')
          .select('id');
        if (cancelled.data?.length) await addEvent(conv.id, 'notice', { text: 'Stopped.' });
        await db.from('conversations').update({ stop_requested: false, status: 'idle' }).eq('id', conv.id);
      }
    }
  }

  async function takePending() {
    const { data, error } = await db
      .from('events')
      .select('id, conversation_id')
      .eq('kind', 'user')
      .eq('state', 'pending')
      .order('id', { ascending: true })
      .limit(50);
    if (error) throw new Error(error.message);
    const seen = new Set();
    for (const ev of data ?? []) {
      // One message at a time per conversation, in order.
      if (seen.has(ev.conversation_id)) continue;
      seen.add(ev.conversation_id);
      const job = jobs.get(ev.conversation_id);
      if (job?.active) continue;
      if (job) {
        // The last reply left something running. It has to end before this chat can continue;
        // the short grace period lets a process that is simply exiting do so quietly.
        if (!job.ending && Date.now() - job.turnEndedAt >= lingerGrace) {
          job.ending = true;
          job.stopReason = 'Background work from the previous step was stopped so this chat could continue.';
          job.run.stop();
        }
        continue;
      }
      if (activeCount() >= MAX_PARALLEL) continue;
      await startJob(ev);
    }
  }

  let ticking = false;
  let again = false;
  async function tick() {
    if (ticking) {
      again = true;
      return;
    }
    ticking = true;
    try {
      do {
        again = false;
        await handleStops();
        if (!standingDown && !shuttingDown) await takePending();
      } while (again);
    } catch (err) {
      log('could not check for work:', err.message);
    } finally {
      ticking = false;
    }
  }

  // --- staying in touch ---------------------------------------------------

  function reportRunning() {
    db.from('devices').update({ running: activeCount(), last_seen: new Date().toISOString() }).eq('id', me).then(() => {});
  }

  const setting = (key, value) =>
    db.from('app_settings').upsert({ key, value }).then(({ error }) => error && log(`could not save ${key}:`, error.message));

  // Plan usage, as Claude last reported it during a task.
  let latestUsage = null;
  let usageAt = 0;
  function saveUsage(force) {
    if (!latestUsage || (!force && Date.now() - usageAt < USAGE_MS)) return;
    usageAt = Date.now();
    const value = { ...latestUsage, updated_at: new Date().toISOString() };
    latestUsage = null;
    return setting('usage', value);
  }

  // --- staying awake ------------------------------------------------------

  // The owner's stay-awake switch lives in their account's preferences, per laptop, because that is
  // the one place the website may write that is not a chat. On unless they turned it off.
  const readWanted =
    deps.readWanted ??
    (async () => {
      const { data, error } = await db.auth.admin.getUserById(config.ownerId);
      if (error) throw new Error(error.message);
      return data.user?.user_metadata?.keep_awake?.[me] !== false;
    });
  let awakeWanted = true;
  let batteryLow = false;

  /** Holds or releases the wake lock: awake when the owner wants it, unless the battery is nearly empty. */
  async function applyAwake(state) {
    const low = batteryTooLow(state, batteryLow);
    const newlyLow = low && !batteryLow;
    batteryLow = low;
    if (awakeWanted && !low) wakeLock?.hold();
    else wakeLock?.release();
    if (newlyLow && awakeWanted) {
      log(`battery under ${SLEEP_BELOW}%: no longer keeping the laptop awake`);
      await push.notify({
        title: `${config.deviceName}: battery under ${SLEEP_BELOW}%`,
        body: 'It is no longer kept awake and will go to sleep. It stays awake again once it is charging.',
        url: '/',
      });
    }
  }

  async function syncAwake() {
    let wanted;
    try {
      wanted = await readWanted();
    } catch (err) {
      return log('could not read the stay-awake setting:', err.message);
    }
    if (wanted === awakeWanted) return;
    awakeWanted = wanted;
    log(wanted ? 'stay awake: on' : 'stay awake: off, the laptop may sleep');
    await reportHealth();
  }

  let warnedLowBattery = false;
  async function reportHealth() {
    const state = health();
    await applyAwake(state);
    await setting(`health:${me}`, {
      ...state,
      awake: wakeLock ? wakeLock.held : awakeWanted && !batteryLow,
      awake_wanted: awakeWanted,
      awake_low: awakeWanted && batteryLow,
      v: HELPER_VERSION,
      updated_at: new Date().toISOString(),
    });
    const low = state.battery !== null && !state.plugged && state.battery <= LOW_BATTERY;
    if (low && !warnedLowBattery) {
      warnedLowBattery = true;
      await push.notify({
        title: `${config.deviceName}: battery at ${state.battery}%`,
        body: 'It is running on battery. Tasks stop if it runs out.',
        url: '/',
      });
    } else if (state.plugged || state.battery === null || state.battery >= LOW_BATTERY + 10) {
      warnedLowBattery = false;
    }
  }

  let foldersAt = Date.now();
  async function heartbeat() {
    const patch = { running: activeCount(), last_seen: new Date().toISOString() };
    if (Date.now() - foldersAt > FOLDERS_MS) {
      patch.folders = listFolders(config.extraFolders);
      foldersAt = Date.now();
    }
    const { data, error } = await db.from('devices').update(patch).eq('id', me).select('active').maybeSingle();
    if (error) return log('heartbeat failed:', error.message);
    if (data && !data.active) return standDown();
    await syncAwake();
  }

  // Old command output is the bulk of the database; the conversation itself is kept.
  async function tidy() {
    const days = config.keepOutputDays ?? KEEP_OUTPUT_DAYS;
    if (!days) return;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const { error } = await db.from('events').delete().eq('kind', 'tool_result').lt('created_at', cutoff);
    if (error) log('could not tidy old output:', error.message);
  }

  // Files sent to the phone are kept longer than output, but not forever: storage is limited.
  async function tidySentFiles() {
    try {
      const removed = await tidyFiles(db, config.keepFilesDays ?? KEEP_FILES_DAYS);
      if (removed) log(`cleared ${removed} old sent file${removed === 1 ? '' : 's'}`);
    } catch (err) {
      log('could not tidy old files:', err.message);
    }
  }

  // The helper finds work by asking every few seconds. That survives sleep and network drops,
  // and keeps it off the live-update quota, which the phone needs.
  if (standalone) {
    timers.push(
      setInterval(tick, POLL_MS),
      setInterval(heartbeat, HEARTBEAT_MS),
      setInterval(reportHealth, HEALTH_MS),
      setInterval(tidy, TIDY_MS),
      setInterval(tidySentFiles, TIDY_MS),
    );
    // Read the stay-awake switch first, so a laptop the owner let sleep is not held awake on start.
    await syncAwake();
    reportHealth();
    tidy();
    tidySentFiles();
    tick();
  }
  return { tick, heartbeat, reportHealth, tidy, shutdown, jobs, activeCount };
}
