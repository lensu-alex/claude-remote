import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { dayFolder, findConversation, sendFiles, tidyFiles, typeOf } from '../src/files.js';
import { fakeDb } from './fake-db.js';

const config = { deviceId: 'mac', ownerId: 'owner' };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-'));
const write = (name, bytes) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  return file;
};

// Storage as the helper uses it: a flat map of key -> bytes, listed one folder level at a time.
function withStorage(db, objects = new Map()) {
  const bucket = {
    async upload(key, bytes) {
      objects.set(key, bytes);
      return { data: { path: key }, error: null };
    },
    async createSignedUrl(key, seconds) {
      return { data: { signedUrl: `https://files.example/${key}?token=t&for=${seconds}` }, error: null };
    },
    async list(prefix) {
      const base = prefix ? `${prefix}/` : '';
      const names = new Set();
      for (const key of objects.keys()) if (key.startsWith(base)) names.add(key.slice(base.length).split('/')[0]);
      return { data: [...names].map((name) => ({ name })), error: null };
    },
    async remove(keys) {
      keys.forEach((key) => objects.delete(key));
      return { data: [], error: null };
    },
  };
  db.storage = { createBucket: async () => ({ error: { message: 'The resource already exists' } }), from: () => bucket };
  return objects;
}

test('a sent file is uploaded and shows up in the chat with a link', async () => {
  const db = fakeDb({ events: [] });
  const objects = withStorage(db);
  const sent = await sendFiles(db, config, { conversationId: 'c1', paths: [write('notes.txt', 300)], caption: ' The notes ' });
  assert.equal(sent.length, 1);
  assert.equal(objects.size, 1);
  const [key] = objects.keys();
  assert.match(key, new RegExp(`^${dayFolder()}/c1/[0-9a-f]{8}-notes\\.txt$`));
  const event = db.tables.events[0];
  assert.equal(event.kind, 'text');
  assert.equal(event.conversation_id, 'c1');
  assert.equal(event.body.text, 'The notes');
  assert.deepEqual(Object.keys(event.body.files[0]).sort(), ['name', 'size', 'type', 'url']);
  assert.equal(event.body.files[0].type, 'text/plain');
  assert.match(event.body.files[0].url, /^https:\/\/files\.example\//);
});

test('a small picture is marked to show inline', async () => {
  const db = fakeDb({ events: [] });
  withStorage(db);
  const [file] = await sendFiles(db, config, { conversationId: 'c1', paths: [write('shot.png', 1000)] });
  assert.equal(file.image, true);
  assert.equal(file.preview, undefined);
  assert.equal(typeOf('a/b/Report.PDF'), 'application/pdf');
  assert.equal(typeOf('thing.xyz'), 'application/octet-stream');
});

test('what cannot be sent is refused with a reason, before anything is uploaded', async () => {
  const db = fakeDb({ events: [] });
  const objects = withStorage(db);
  const send = (paths) => sendFiles(db, config, { conversationId: 'c1', paths });
  await assert.rejects(send([]), /at least one file/);
  await assert.rejects(send([path.join(dir, 'missing.png')]), /does not exist/);
  await assert.rejects(send([dir]), /not a file/);
  await assert.rejects(send([write('ok.txt', 10), write('huge.bin', 20_000_001)]), /too large/);
  assert.equal(objects.size, 0);
  assert.equal(db.tables.events.length, 0);
});

test('the chat is the one Claude runs in, or the only one running', async () => {
  const running = (id) => ({ id, device_id: 'mac', status: 'running' });
  assert.equal(await findConversation(fakeDb({ conversations: [running('a'), running('b')] }), config, 'named'), 'named');
  assert.equal(await findConversation(fakeDb({ conversations: [running('a')] }), config, ''), 'a');
  await assert.rejects(findConversation(fakeDb({ conversations: [] }), config, ''), /No task is running/);
  await assert.rejects(findConversation(fakeDb({ conversations: [running('a'), running('b')] }), config, ''), /Several tasks/);
});

test('sent files older than the limit are cleared, newer ones are kept', async () => {
  const db = fakeDb({});
  const now = new Date('2026-11-23T10:00:00Z');
  const objects = withStorage(
    db,
    new Map([
      ['d20260701/c1/aaaa-old.png', 1],
      ['d20260701/c1/aaaa-old.png.preview.jpg', 1],
      ['d20260820/c2/bbbb-also-old.pdf', 1],
      ['d20261120/c1/cccc-new.png', 1],
    ]),
  );
  assert.equal(await tidyFiles(db, 90, now), 3);
  assert.deepEqual([...objects.keys()], ['d20261120/c1/cccc-new.png']);
  assert.equal(await tidyFiles(db, 0, now), 0);
});
