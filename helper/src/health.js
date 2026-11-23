// Battery and charger state of this laptop, shown on the phone so a dying laptop is not a surprise.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Parses `pmset -g batt` on macOS. */
export function parsePmset(text) {
  const percent = text.match(/(\d+)%/);
  if (!percent) return { battery: null, plugged: true, charging: false };
  const plugged = /'AC Power'/.test(text) || /AC attached/.test(text);
  const charging = /;\s*(charging|finishing charge)\b/.test(text);
  return { battery: Number(percent[1]), plugged, charging };
}

/** Reads /sys/class/power_supply on Linux. */
export function readSysfs(root = '/sys/class/power_supply') {
  const read = (file) => {
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch {
      return null;
    }
  };
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {}
  const battery = names.find((n) => read(path.join(root, n, 'type')) === 'Battery' && read(path.join(root, n, 'capacity')) !== null);
  if (!battery) return { battery: null, plugged: true, charging: false };
  const status = read(path.join(root, battery, 'status')) ?? '';
  const mains = names.some((n) => read(path.join(root, n, 'type')) === 'Mains' && read(path.join(root, n, 'online')) === '1');
  return {
    battery: Number(read(path.join(root, battery, 'capacity'))),
    plugged: mains || (status !== 'Discharging' && status !== ''),
    charging: status === 'Charging',
  };
}

/** { battery: 0-100 | null, plugged, charging }; never throws. */
export function readHealth() {
  try {
    if (process.platform === 'darwin') return parsePmset(execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8' }));
    if (process.platform === 'linux') return readSysfs();
  } catch {}
  return { battery: null, plugged: true, charging: false };
}
