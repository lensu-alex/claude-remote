// Keeping the laptop awake, and deciding when it should be.

import { spawn, spawnSync } from 'node:child_process';

/** Below this, on battery, the laptop is let go to sleep whatever the owner chose. */
export const SLEEP_BELOW = 10;
/** Once let go, it is kept awake again only when it is charging or back above this. */
const AWAKE_AGAIN_AT = 15;

/**
 * True when the battery is too low to keep the laptop awake. `wasLow` is the previous answer:
 * a battery hovering around the limit must not switch the laptop back and forth.
 */
export function batteryTooLow(health, wasLow = false) {
  if (!health || health.battery === null || health.plugged) return false;
  return health.battery < (wasLow ? AWAKE_AGAIN_AT : SLEEP_BELOW);
}

/**
 * Turns the Mac's sleep off or back on as a whole, which is the only thing that keeps it awake
 * with the lid closed on battery. Needs the sudoers rule from `setup-lid.sh`; false without it.
 */
function lidSleep(off) {
  const run = spawnSync('sudo', ['-n', '/usr/bin/pmset', '-a', 'disablesleep', off ? '1' : '0'], { stdio: 'ignore' });
  return run.status === 0;
}

function start(log) {
  const quiet = { stdio: 'ignore' };
  if (process.platform === 'darwin') {
    const child = spawn('caffeinate', ['-i', '-s', '-w', String(process.pid)], quiet);
    child.on('error', () => log('could not start caffeinate; the laptop may sleep'));
    const lid = lidSleep(true);
    if (!lid) log('closing the lid will still sleep the laptop; run setup-lid.sh once to change that');
    return {
      kill() {
        child.kill();
        if (lid) lidSleep(false);
      },
    };
  }
  if (process.platform === 'linux') {
    // `tail --pid` ends on its own when the helper exits, which releases the lock.
    const run = (what) =>
      spawn(
        'systemd-inhibit',
        [`--what=${what}`, '--who=claude-remote', '--why=Remote tasks may be running', 'tail', `--pid=${process.pid}`, '-f', '/dev/null'],
        quiet,
      );
    let child = run('idle:sleep:handle-lid-switch');
    let released = false;
    const started = Date.now();
    child.on('error', () => log('could not start systemd-inhibit; the laptop may sleep'));
    child.on('exit', () => {
      // Blocking the lid switch can be refused; fall back to blocking idle sleep only.
      if (!released && Date.now() - started < 3000) {
        child = run('idle:sleep');
        child.on('error', () => {});
      }
    });
    return {
      kill() {
        released = true;
        child.kill();
      },
    };
  }
  return null;
}

/**
 * Stops the laptop from sleeping for as long as it is held, lid closed included once setup-lid.sh has run.
 * Releasing it hands sleep back to the system's own settings.
 */
export function createWakeLock(log = () => {}) {
  let holder = null;
  return {
    get held() {
      return holder !== null;
    },
    hold() {
      holder ??= start(log);
    },
    release() {
      holder?.kill();
      holder = null;
    },
  };
}
