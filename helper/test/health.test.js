import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parsePmset, readHealth, readSysfs } from '../src/health.js';

test('reads macOS battery reports', () => {
  assert.deepEqual(
    parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; AC attached; not charging present: true"),
    { battery: 80, plugged: true, charging: false },
  );
  assert.deepEqual(
    parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t54%; charging; 1:10 remaining present: true"),
    { battery: 54, plugged: true, charging: true },
  );
  assert.deepEqual(
    parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t17%; discharging; 0:40 remaining present: true"),
    { battery: 17, plugged: false, charging: false },
  );
  assert.deepEqual(parsePmset("Now drawing from 'AC Power'"), { battery: null, plugged: true, charging: false });
});

test('reads Linux battery files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'power-'));
  const put = (name, files) => {
    fs.mkdirSync(path.join(root, name));
    for (const [file, value] of Object.entries(files)) fs.writeFileSync(path.join(root, name, file), `${value}\n`);
  };
  put('BAT0', { type: 'Battery', capacity: 43, status: 'Discharging' });
  put('AC', { type: 'Mains', online: 0 });
  assert.deepEqual(readSysfs(root), { battery: 43, plugged: false, charging: false });
  fs.writeFileSync(path.join(root, 'AC', 'online'), '1\n');
  fs.writeFileSync(path.join(root, 'BAT0', 'status'), 'Charging\n');
  assert.deepEqual(readSysfs(root), { battery: 43, plugged: true, charging: true });
  assert.deepEqual(readSysfs(path.join(root, 'missing')), { battery: null, plugged: true, charging: false });
});

test('the real reading on this machine has the right shape', () => {
  const state = readHealth();
  assert.ok(state.battery === null || (state.battery >= 0 && state.battery <= 100));
  assert.equal(typeof state.plugged, 'boolean');
});
