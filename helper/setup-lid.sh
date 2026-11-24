#!/bin/sh
# Run once on the Mac: lets the helper keep the laptop awake with the lid closed.
# It allows exactly two commands without a password: turning sleep off and back on.
set -e
rule="$(whoami) ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0"
tmp="$(mktemp)"
echo "$rule" > "$tmp"
sudo visudo -cf "$tmp"
sudo install -m 0440 -o root -g wheel "$tmp" /etc/sudoers.d/claude-remote
rm -f "$tmp"
echo "Done. Restart the helper (remote off, remote on) to use it."
