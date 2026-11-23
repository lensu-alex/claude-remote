// Sending a picture or file from the laptop to the owner's phone (`remote send`, run by Claude
// during a task). The file goes to a private storage bucket, and the chat gets a message that
// links to it through a signed address only the owner's app ever sees.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BUCKET = 'files';
export const MAX_FILE_BYTES = 20_000_000;
export const MAX_FILES = 6;
export const KEEP_FILES_DAYS = 90;
const PREVIEW_OVER_BYTES = 400_000;
const PREVIEW_PIXELS = 1600;

const TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  json: 'application/json', html: 'text/html', zip: 'application/zip', mp4: 'video/mp4', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
// Pictures the phone can show inline. Everything else is offered as a download.
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function typeOf(file) {
  return TYPES[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

const safeName = (name) => name.replace(/[^\w.-]+/g, '_').slice(-80) || 'file';
/** Storage folder for a day, so old files can be cleared a day at a time: "d20261123". */
export const dayFolder = (date = new Date()) => `d${date.toISOString().slice(0, 10).replace(/-/g, '')}`;
const expiry = (days) => (days ? days : 3650) * 86_400;

/** A smaller JPEG of a large picture, so the chat loads quickly on a phone. macOS only; null when not possible. */
function makePreview(file) {
  if (process.platform !== 'darwin') return null;
  const out = path.join(os.tmpdir(), `remote-preview-${randomUUID()}.jpg`);
  try {
    execFileSync('sips', ['-Z', String(PREVIEW_PIXELS), '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', file, '--out', out], { stdio: 'ignore' });
    return fs.statSync(out).size > 0 ? out : null;
  } catch {
    return null;
  }
}

async function ensureBucket(db) {
  const { error } = await db.storage.createBucket(BUCKET, { public: false });
  if (error && !/already exists|duplicate/i.test(error.message ?? '')) throw new Error(`Could not prepare storage: ${error.message}`);
}

async function upload(db, key, file, type, days) {
  const sent = await db.storage.from(BUCKET).upload(key, fs.readFileSync(file), { contentType: type, upsert: false });
  if (sent.error) throw new Error(`Could not upload ${path.basename(file)}: ${sent.error.message}`);
  const signed = await db.storage.from(BUCKET).createSignedUrl(key, expiry(days));
  if (signed.error) throw new Error(`Could not share ${path.basename(file)}: ${signed.error.message}`);
  return signed.data.signedUrl;
}

/**
 * Uploads `paths` and adds one message to the chat that shows them. Returns the files as stored.
 * Throws with a plain sentence when something cannot be sent.
 */
export async function sendFiles(db, config, { conversationId, paths, caption = '' }) {
  if (!paths.length) throw new Error('Name at least one file to send.');
  if (paths.length > MAX_FILES) throw new Error(`Send at most ${MAX_FILES} files at a time.`);
  const files = paths.map((p) => path.resolve(p));
  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new Error(`${file} does not exist.`);
    }
    if (!stat.isFile()) throw new Error(`${file} is not a file. To send a folder, zip it first.`);
    if (stat.size === 0) throw new Error(`${file} is empty.`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`${file} is over ${MAX_FILE_BYTES / 1_000_000} MB, which is too large to send.`);
  }

  const days = config.keepFilesDays ?? KEEP_FILES_DAYS;
  await ensureBucket(db);
  const folder = `${dayFolder()}/${conversationId}`;
  const stored = [];
  for (const file of files) {
    const type = typeOf(file);
    const name = path.basename(file);
    const key = `${folder}/${randomUUID().slice(0, 8)}-${safeName(name)}`;
    const entry = { name, type, size: fs.statSync(file).size, url: await upload(db, key, file, type, days) };
    if (INLINE.has(type)) {
      entry.image = true;
      const preview = entry.size > PREVIEW_OVER_BYTES ? makePreview(file) : null;
      if (preview) {
        try {
          entry.preview = await upload(db, `${key}.preview.jpg`, preview, 'image/jpeg', days);
        } finally {
          fs.rmSync(preview, { force: true });
        }
      }
    }
    stored.push(entry);
  }

  const { error } = await db
    .from('events')
    .insert({ conversation_id: conversationId, user_id: config.ownerId, kind: 'text', body: { text: caption.trim(), files: stored } });
  if (error) throw new Error(`The files were uploaded but the chat could not be updated: ${error.message}`);
  return stored;
}

/** The chat a `remote send` belongs to: the one Claude is running in, or the only one running on this laptop. */
export async function findConversation(db, config, explicit) {
  const named = explicit || process.env.CLAUDE_REMOTE_CONVERSATION;
  if (named) return named;
  const { data, error } = await db.from('conversations').select('id').eq('device_id', config.deviceId).eq('status', 'running');
  if (error) throw new Error(`Could not reach the database: ${error.message}`);
  if (data.length === 1) return data[0].id;
  throw new Error(
    data.length
      ? 'Several tasks are running, so it is not clear which chat this belongs to. The helper needs a restart to tell them apart (remote off, then remote on).'
      : 'No task is running, so there is no chat to send this to.',
  );
}

/** Removes sent files older than `days`. They are stored in one folder per day. */
export async function tidyFiles(db, days, now = new Date()) {
  if (!days) return 0;
  const cutoff = dayFolder(new Date(now.getTime() - days * 86_400_000));
  const bucket = db.storage.from(BUCKET);
  const top = await bucket.list('', { limit: 1000 });
  if (top.error) return 0; // no bucket yet: nothing was ever sent
  let removed = 0;
  for (const day of top.data.filter((entry) => /^d\d{8}$/.test(entry.name) && entry.name < cutoff)) {
    const chats = await bucket.list(day.name, { limit: 1000 });
    for (const chat of chats.data ?? []) {
      const files = await bucket.list(`${day.name}/${chat.name}`, { limit: 1000 });
      const keys = (files.data ?? []).map((f) => `${day.name}/${chat.name}/${f.name}`);
      if (keys.length) {
        await bucket.remove(keys);
        removed += keys.length;
      }
    }
  }
  return removed;
}
