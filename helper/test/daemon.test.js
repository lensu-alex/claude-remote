import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startDaemon } from '../src/daemon.js';
import { fakeDb } from './fake-db.js';

const config = { deviceId: 'mac', deviceName: 'Mac', ownerId: 'owner', ownerEmail: 'o@example.com' };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// A fake Claude: replies at once unless the prompt says otherwise.
function fakeClaude(calls) {
  return ({ prompt, sessionId, resume, model, effort, conversationId, onEvents, onSession, onUsage, onTurnEnd }) => {
    calls.push({ prompt, sessionId, resume, model, effort, conversationId });
    let finishRun;
    const done = new Promise((resolve) => (finishRun = resolve));
    // Like the real runner: a completed reply reports a turn end, then the process exits.
    const finish = (outcome) => {
      onTurnEnd?.({ ok: outcome.ok, text: outcome.text, limit: outcome.limit, question: Boolean(outcome.question) });
      finishRun(outcome);
    };
    onSession(sessionId);
    if (prompt === 'ask') {
      onUsage({ limited: false, five_hour: { used: 0.4, resets_at: null } });
      onEvents([{ kind: 'tool', body: { id: 't1', name: 'Bash', summary: 'npm test' } }]);
      onEvents([{ kind: 'text', body: { text: 'Tests pass.\n\nShould I commit?' } }]);
      finish({ ok: true, text: 'Tests pass.\n\nShould I commit?', limit: false, question: true, stopped: false, sawResult: true });
    } else if (prompt === 'linger') {
      // Replies, but the process stays alive because it left something running in the background.
      onEvents([{ kind: 'text', body: { text: 'Server started.' } }, { kind: 'result', body: { ok: true } }]);
      onTurnEnd({ ok: true, text: 'Server started.', limit: false, question: false });
    } else if (prompt === 'hang') {
      onEvents([{ kind: 'tool', body: { id: 't1', name: 'Bash', summary: 'long job' } }]);
    } else if (prompt === 'fail') {
      onEvents([{ kind: 'error', body: { text: 'Claude usage limit reached', limit: true } }]);
      finish({ ok: false, text: 'Claude usage limit reached', limit: true, stopped: false, sawResult: true });
    } else {
      onEvents([{ kind: 'text', body: { text: `reply to ${prompt}` } }, { kind: 'result', body: { ok: true } }]);
      finish({ ok: true, text: `reply to ${prompt}`, limit: false, stopped: false, sawResult: true });
    }
    return {
      done,
      stop: () => finishRun({ ok: false, text: '', limit: false, stopped: true, sawResult: false }),
    };
  };
}

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-'));
let power = { battery: 80, plugged: true, charging: false };
let stayAwake = true;

async function boot(tables) {
  const db = fakeDb({ devices: [], conversations: [], events: [], app_settings: [], ...tables });
  const calls = [];
  const pushes = [];
  const exits = [];
  const lock = {
    held: false,
    hold() {
      this.held = true;
    },
    release() {
      this.held = false;
    },
  };
  const daemon = await startDaemon({
    config,
    db,
    runClaude: fakeClaude(calls),
    push: { notify: async (payload) => pushes.push(payload) },
    exit: (code) => exits.push(code),
    readHealth: () => power,
    wakeLock: lock,
    readWanted: async () => stayAwake,
    uploadDir,
    lingerGraceMs: 0,
  });
  return { db, t: db.tables, calls, pushes, exits, daemon, lock };
}

const conversation = (extra = {}) => ({
  id: 'c1', user_id: 'owner', title: 'Fix tests', cwd: os.tmpdir(), device_id: null, claude_session_id: null,
  status: 'queued', stop_requested: false, ...extra,
});
const message = (id, text, extra = {}) => ({
  id, conversation_id: 'c1', user_id: 'owner', kind: 'user', state: 'pending', body: { text }, ...extra,
});

test('messages from anyone but the owner are never run', async () => {
  const { t, calls, daemon } = await boot({
    conversations: [conversation({ id: 'c2', user_id: 'stranger' })],
    events: [message(1, 'rm -rf ~', { conversation_id: 'c2', user_id: 'stranger' })],
  });
  await daemon.tick();
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(t.events[0].state, 'pending');
});

test('turning on makes this laptop the only active one', async () => {
  const { t } = await boot({ devices: [{ id: 'linux', name: 'Linux', active: true }] });
  assert.equal(t.devices.find((d) => d.id === 'linux').active, false);
  assert.equal(t.devices.find((d) => d.id === 'mac').active, true);
});

test('runs a pending message and records the outcome', async () => {
  const { t, calls, pushes, daemon } = await boot({ conversations: [conversation()], events: [message(1, 'hello')] });
  await daemon.tick();
  await settle();

  assert.deepEqual(calls.map((c) => [c.prompt, c.resume]), [['hello', false]]);
  assert.deepEqual(t.events.map((e) => e.kind), ['user', 'text', 'result']);
  assert.equal(t.events[0].state, 'done');
  const conv = t.conversations[0];
  assert.equal(conv.status, 'idle');
  assert.equal(conv.device_id, 'mac');
  assert.equal(conv.claude_session_id, calls[0].sessionId);
  assert.equal(conv.last_text, 'reply to hello');
  assert.deepEqual(pushes, [{ title: 'Fix tests', body: 'reply to hello', url: '/c/c1' }]);
});

test('messages in one conversation run in order, and the second resumes the session', async () => {
  const { t, calls, daemon } = await boot({
    conversations: [conversation()],
    events: [message(1, 'first'), message(2, 'second')],
  });
  await daemon.tick();
  await settle();
  await settle();

  assert.deepEqual(calls.map((c) => [c.prompt, c.resume]), [['first', false], ['second', true]]);
  assert.equal(calls[1].sessionId, calls[0].sessionId);
  assert.ok(t.events.filter((e) => e.kind === 'user').every((e) => e.state === 'done'));
});

test('stop ends the running task and cancels what was queued behind it', async () => {
  const { t, calls, pushes, daemon } = await boot({
    conversations: [conversation()],
    events: [message(1, 'hang'), message(2, 'later')],
  });
  await daemon.tick();
  await settle();
  assert.equal(t.conversations[0].status, 'running');
  assert.equal(daemon.jobs.size, 1);

  t.conversations[0].stop_requested = true;
  await daemon.tick();
  await settle();

  assert.equal(daemon.jobs.size, 0);
  assert.deepEqual(calls.map((c) => c.prompt), ['hang']);
  assert.equal(t.events.find((e) => e.id === 2).state, 'cancelled');
  assert.ok(t.events.some((e) => e.kind === 'notice' && e.body.text === 'Stopped.'));
  assert.equal(t.conversations[0].status, 'idle');
  assert.equal(t.conversations[0].stop_requested, false);
  assert.deepEqual(pushes, []);
});

test('a failed task is marked for attention and the limit is named', async () => {
  const { t, pushes, daemon } = await boot({ conversations: [conversation()], events: [message(1, 'fail')] });
  await daemon.tick();
  await settle();
  assert.equal(t.conversations[0].status, 'error');
  assert.equal(pushes[0].title, 'Needs attention: Fix tests');
  assert.equal(pushes[0].body, 'Stopped: the usage limit was reached.');
});

test("a chat that lives on another laptop is refused, not run", async () => {
  const { t, calls, daemon } = await boot({
    conversations: [conversation({ device_id: 'linux', claude_session_id: 's1' })],
    events: [message(1, 'hello')],
  });
  await daemon.tick();
  await settle();
  assert.deepEqual(calls, []);
  assert.equal(t.events[0].state, 'cancelled');
  assert.ok(t.events.some((e) => e.kind === 'error' && /another laptop/.test(e.body.text)));
});

test('a missing folder is reported instead of run', async () => {
  const { t, calls, daemon } = await boot({
    conversations: [conversation({ cwd: '/no/such/folder' })],
    events: [message(1, 'hello')],
  });
  await daemon.tick();
  await settle();
  assert.deepEqual(calls, []);
  assert.ok(t.events.some((e) => e.kind === 'error' && /does not exist/.test(e.body.text)));
});

test('when another laptop takes over, it finishes its task, takes no new ones, then exits', async () => {
  const { t, calls, exits, daemon } = await boot({
    conversations: [conversation(), conversation({ id: 'c2' })],
    events: [message(1, 'hang')],
  });
  await daemon.tick();
  await settle();

  t.devices.find((d) => d.id === 'mac').active = false; // the other laptop ran `remote on`
  await daemon.heartbeat();
  t.events.push(message(2, 'new work', { conversation_id: 'c2' }));
  await daemon.tick();
  await settle();
  assert.deepEqual(calls.map((c) => c.prompt), ['hang']);
  assert.deepEqual(exits, []);

  t.conversations[0].stop_requested = true;
  await daemon.tick();
  await settle();
  assert.deepEqual(exits, [0]);
  assert.equal(t.events.find((e) => e.id === 2).state, 'pending');
});

test('tasks cut off by a crash are flagged on the next start', async () => {
  const { t } = await boot({
    conversations: [conversation({ device_id: 'mac', status: 'running' })],
    events: [message(1, 'hello', { state: 'running' })],
  });
  assert.equal(t.conversations[0].status, 'error');
  assert.equal(t.events[0].state, 'done');
  assert.ok(t.events.some((e) => e.kind === 'notice' && /restarted/.test(e.body.text)));
});

test('a question becomes the preview and the notification says so; usage and the live step are saved', async () => {
  const { t, pushes, daemon } = await boot({ conversations: [conversation()], events: [message(1, 'ask')] });
  await daemon.tick();
  await settle();
  assert.equal(t.conversations[0].last_text, 'Should I commit?');
  assert.equal(pushes[0].title, 'Question: Fix tests');
  assert.equal(t.app_settings.find((r) => r.key === 'usage').value.five_hour.used, 0.4);
});

test('the current step is shown while a task runs', async () => {
  const { t, daemon } = await boot({ conversations: [conversation()], events: [message(1, 'hang')] });
  await daemon.tick();
  await settle();
  assert.equal(t.conversations[0].last_text, 'Bash  long job');
  t.conversations[0].stop_requested = true;
  await daemon.tick();
  await settle();
});

test('photos are saved on the laptop, removed from the database, and named in the prompt', async () => {
  const pixel = Buffer.from('fake jpeg bytes').toString('base64');
  const { t, calls, daemon } = await boot({
    conversations: [conversation()],
    events: [
      message(1, '', {
        body: { text: '', images: [{ name: 'a.jpg', type: 'image/jpeg', data: pixel, thumb: 'tt' }, { name: 'x.exe', type: 'application/x-msdownload', data: pixel }] },
      }),
    ],
  });
  await daemon.tick();
  await settle();

  const file = path.join(uploadDir, 'c1', '1-1.jpg');
  assert.equal(fs.readFileSync(file, 'utf8'), 'fake jpeg bytes');
  assert.ok(calls[0].prompt.includes(file));
  assert.ok(!calls[0].prompt.includes('x.exe'));
  assert.deepEqual(t.events[0].body.images, [{ name: 'a.jpg', type: 'image/jpeg', thumb: 'tt', saved: true }]);
});

test('battery is reported, and a low battery on battery power notifies once', async () => {
  const { t, pushes, daemon } = await boot({});
  power = { battery: 80, plugged: true, charging: false };
  await daemon.reportHealth();
  assert.equal(t.app_settings.find((r) => r.key === 'health:mac').value.battery, 80);
  assert.deepEqual(pushes, []);

  power = { battery: 18, plugged: false, charging: false };
  await daemon.reportHealth();
  await daemon.reportHealth();
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].title, /battery at 18%/);

  power = { battery: 19, plugged: true, charging: true };
  await daemon.reportHealth();
  power = { battery: 15, plugged: false, charging: false };
  await daemon.reportHealth();
  assert.equal(pushes.length, 2);
});

test('a reply that leaves something running still counts as finished, and a follow-up continues the chat', async () => {
  const { t, calls, pushes, daemon } = await boot({ conversations: [conversation()], events: [message(1, 'linger')] });
  await daemon.tick();
  await settle();

  assert.equal(t.conversations[0].status, 'idle');
  assert.equal(t.events[0].state, 'done');
  assert.equal(pushes.length, 1);
  assert.equal(daemon.jobs.size, 1, 'the process is still alive');
  assert.equal(daemon.activeCount(), 0, 'but it no longer counts as a running task');

  t.events.push(message(2, 'next'));
  await daemon.tick();
  await settle();
  await settle();

  assert.deepEqual(calls.map((c) => [c.prompt, c.resume]), [['linger', false], ['next', true]]);
  assert.ok(t.events.some((e) => e.kind === 'notice' && /Background work/.test(e.body.text)));
  assert.equal(t.events.find((e) => e.id === 2).state, 'done');
  assert.equal(daemon.jobs.size, 0);
});

test('lingering background work does not use up the parallel task slots', async () => {
  const convs = ['c1', 'c2', 'c3', 'c4'].map((id) => conversation({ id }));
  const { calls, daemon } = await boot({
    conversations: convs,
    events: [
      message(1, 'linger', { conversation_id: 'c1' }),
      message(2, 'linger', { conversation_id: 'c2' }),
      message(3, 'linger', { conversation_id: 'c3' }),
      message(4, 'hello', { conversation_id: 'c4' }),
    ],
  });
  await daemon.tick();
  await settle();
  await settle();
  assert.deepEqual(calls.map((c) => c.prompt), ['linger', 'linger', 'linger', 'hello']);
  await daemon.shutdown('test over');
});

test('at most three tasks work at once; the fourth waits its turn', async () => {
  const convs = ['c1', 'c2', 'c3', 'c4'].map((id) => conversation({ id }));
  const { t, calls, daemon } = await boot({
    conversations: convs,
    events: ['c1', 'c2', 'c3', 'c4'].map((id, i) => message(i + 1, 'hang', { conversation_id: id })),
  });
  await daemon.tick();
  await settle();
  assert.equal(calls.length, 3);
  assert.equal(t.events.find((e) => e.id === 4).state, 'pending');

  t.conversations[0].stop_requested = true;
  await daemon.tick();
  await settle();
  await settle();
  assert.equal(calls.length, 4);
  await daemon.shutdown('test over');
});

test('command output older than a month is cleared, the conversation is kept', async () => {
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const recent = new Date().toISOString();
  const { t, daemon } = await boot({
    events: [
      { id: 1, kind: 'tool_result', created_at: old, body: {} },
      { id: 2, kind: 'text', created_at: old, body: {} },
      { id: 3, kind: 'tool_result', created_at: recent, body: {} },
    ],
  });
  await daemon.tidy();
  assert.deepEqual(t.events.map((e) => e.id), [2, 3]);
});

test('the model and effort chosen for a message reach Claude and are named when it finishes', async () => {
  const { t, calls, daemon } = await boot({
    conversations: [conversation()],
    events: [message(1, 'hello', { body: { text: 'hello', model: 'opus', effort: 'high' } })],
  });
  await daemon.tick();
  await settle();
  assert.equal(calls[0].model, 'opus');
  assert.equal(calls[0].effort, 'high');
  assert.equal(calls[0].conversationId, 'c1');
  const result = t.events.find((e) => e.kind === 'result');
  assert.equal(result.body.model, 'opus');
  assert.equal(result.body.effort, 'high');
});

test('a model or effort that is not a plain name is ignored', async () => {
  const { calls, daemon } = await boot({
    conversations: [conversation()],
    events: [message(1, 'hello', { body: { text: 'hello', model: '--dangerously', effort: 'turbo' } })],
  });
  await daemon.tick();
  await settle();
  assert.equal(calls[0].model, null);
  assert.equal(calls[0].effort, null);
});

test('the laptop is kept awake unless the owner turns that off', async () => {
  stayAwake = true;
  power = { battery: 80, plugged: true, charging: false };
  const { t, daemon, lock } = await boot({});
  await daemon.reportHealth();
  assert.equal(lock.held, true);
  const health = () => t.app_settings.find((r) => r.key === 'health:mac').value;
  assert.equal(health().awake, true);
  assert.equal(health().v, 2);

  stayAwake = false;
  await daemon.heartbeat();
  assert.equal(lock.held, false);
  assert.equal(health().awake, false);
  assert.equal(health().awake_wanted, false);

  stayAwake = true;
  await daemon.heartbeat();
  assert.equal(lock.held, true);
});

test('under 10% on battery it is let go to sleep anyway, and kept awake again once charging', async () => {
  stayAwake = true;
  power = { battery: 40, plugged: false, charging: false };
  const { t, pushes, daemon, lock } = await boot({});
  await daemon.reportHealth();
  assert.equal(lock.held, true);

  power = { battery: 9, plugged: false, charging: false };
  await daemon.reportHealth();
  await daemon.reportHealth();
  assert.equal(lock.held, false);
  const health = t.app_settings.find((r) => r.key === 'health:mac').value;
  assert.equal(health.awake_low, true);
  assert.equal(health.awake_wanted, true);
  assert.equal(pushes.filter((p) => /under 10%/.test(p.title)).length, 1);

  // A battery that creeps back to 11% is not enough; it has to be charging or clearly recovered.
  power = { battery: 11, plugged: false, charging: false };
  await daemon.reportHealth();
  assert.equal(lock.held, false);

  power = { battery: 11, plugged: true, charging: true };
  await daemon.reportHealth();
  assert.equal(lock.held, true);
});
