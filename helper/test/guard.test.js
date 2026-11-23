import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from '../src/guard.js';

const HOME = '/Users/someone';
const CWD = '/Users/someone/Developer/app';
const blocked = (cmd, cwd = CWD) => assert.ok(check(cmd, cwd, HOME), `should block: ${cmd}`);
const allowed = (cmd, cwd = CWD) => assert.equal(check(cmd, cwd, HOME), null, `should allow: ${cmd}`);

test('blocks recursive deletes of broad paths', () => {
  blocked('rm -rf /');
  blocked('rm -rf ~');
  blocked('rm -rf ~/');
  blocked('rm -rf $HOME');
  blocked('rm -rf "$HOME/Developer"');
  blocked('rm -fr ~/Documents');
  blocked('rm -r ~/*');
  blocked('rm -rf ~/Developer/*');
  blocked('sudo rm -rf /usr');
  blocked('rm -rf ~/Library/Preferences');
  blocked('rm -rf *', HOME);
  blocked('rm -rf ..', '/Users/someone/Developer');
  blocked('cd /tmp && rm -rf $TARGET/');
  blocked('echo hi; rm --recursive ~/Desktop');
  blocked('bash -c "rm -rf ~"');
});

test('allows ordinary deletes inside a project', () => {
  allowed('rm -rf node_modules');
  allowed('rm -rf ./dist build');
  allowed('rm notes.txt');
  allowed('rm -rf ~/Developer/app/.next');
  allowed('rm -f ~/file.txt');
  allowed('echo "rm -rf /"');
  allowed('git commit -m "remove rm -rf / from docs"');
});

test('blocks commands that cut the owner off', () => {
  blocked('shutdown -h now');
  blocked('sudo reboot');
  blocked('pmset sleepnow');
  blocked('systemctl suspend');
  blocked('osascript -e \'tell app "System Events" to shut down\'');
  blocked('remote off');
  allowed('remote status');
  allowed('pmset -g');
});

test('blocks disk-level commands', () => {
  blocked('diskutil eraseDisk APFS Blank disk0');
  blocked('dd if=/dev/zero of=/dev/disk2 bs=1m');
  blocked('mkfs.ext4 /dev/sda1');
  allowed('diskutil list');
  allowed('dd if=in.img of=out.img');
});

test('blocks broad find deletes', () => {
  blocked('find ~ -name "*.log" -delete');
  blocked('find ~/Developer -name node_modules -exec rm -rf {} +');
  allowed('find . -name "*.pyc" -delete');
  allowed('find ~ -name "*.log"');
});

test('leaves normal work alone', () => {
  allowed('npm test 2>&1 | tail -20');
  allowed('git status && git diff');
  allowed('ls -la ~');
  allowed('');
});
