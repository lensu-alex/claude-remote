# How the website and the laptop helper talk

Both sides only read and write the Supabase tables in `supabase/schema.sql`. Neither calls the other directly.

## Who writes what

| Action | Who | What is written |
|---|---|---|
| Start a chat | website | insert `conversations` (`title`, `cwd`) |
| Send a message | website | insert `events` (`kind='user'`, `state='pending'`, `body={text}`), then set `conversations.status='queued'` |
| Choose model and effort | website | `model` and `effort` in that message's `body` (see "Model and effort") |
| Turn stay-awake on or off | website | the owner's account preferences (see "Staying awake") |
| Stop a task | website | set `conversations.stop_requested=true` |
| Delete a chat | website | delete `conversations` row (events cascade) |
| Turn on notifications | website | upsert `push_subscriptions` by `endpoint` |
| Everything else | helper | device heartbeat, claiming messages, Claude's output, status changes, push sending |

## Device state the website shows

- A laptop is **on** when `devices.active = true` and `last_seen` is under 60 seconds old.
- `devices.running` is the number of tasks in progress.
- `devices.folders` is the list offered in the folder picker: `[{ "path": "...", "label": "..." }]`.
- A conversation with a `device_id` different from the active laptop is read-only: it can only continue on the laptop that ran it.

## Event bodies

See the comment above `public.events` in `supabase/schema.sql`. `tool` and `tool_result` rows pair up through `body.id` / `body.tool_id`.

## Push notifications

- The public key is in `app_settings` under `vapid_public_key` (value is a JSON string).
- The helper sends the push. Payload: `{ "title": "...", "body": "...", "url": "/c/<conversation id>" }`.
- The website's service worker must show a notification for every push and open `url` when it is tapped.

## Website configuration

Only two public values: `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`, in `web/.env.local`. No secret ever goes in the website.

## Laptop health and plan usage

The helper keeps two kinds of rows in `app_settings` (the website can read this table, not write it):

- `health:<device id>`: `{ "battery": 80, "plugged": true, "charging": false, "updated_at": "<iso>" }`. `battery` is 0 to 100, or `null` when the machine has no battery. Refreshed about once a minute while the laptop is on.
- `usage`: `{ "five_hour": { "used": 0.02, "resets_at": "<iso>" }, "seven_day": { "used": 0.21, "resets_at": "<iso>" }, "limited": false, "updated_at": "<iso>" }`. `used` is 0 to 1. Either window may be missing. Claude only reports this while a task runs, so it can be stale; show `updated_at` when it is old. A window whose `resets_at` is in the past has reset, so treat its `used` as 0.

`app_settings` is not part of live updates. The website refetches it on load, when the page becomes visible again, and at most once a minute while open.

## What a running task is doing

While a task runs, the helper sets `conversations.last_text` to the current step (for example `Bash  npm test`), at most once every 3 seconds. When the task ends, `last_text` becomes the first line of Claude's reply, or the question itself when Claude ended by asking one. So: `status = 'running'` means `last_text` is a step; otherwise it is reply text.

When Claude ended by asking something, the closing `result` event has `body.question = true` and the push title starts with `Question:`.

## Attached photos

A `user` event body may carry up to 3 images:

```json
{ "text": "why does this look wrong?",
  "images": [ { "name": "photo.jpg", "type": "image/jpeg", "data": "<base64, no data: prefix>", "thumb": "<base64 jpeg, longest side 160px>" } ] }
```

- The website shrinks each image to at most 1280px on its longest side as JPEG, and keeps `data` under about 400 KB of base64.
- `text` may be empty when there is at least one image.
- The helper saves each image on the laptop, then rewrites the event body so each image is `{ "name", "type", "thumb", "saved": true }` with `data` removed. The website shows `thumb`.

## Stop everything

The website sets `stop_requested = true` on every conversation whose status is `running` or `queued`.

## What the helper can do

Each `health:<device id>` row carries `"v"`, a number that goes up when the helper learns something the website has to ask for. The website offers a control only when the laptop's `v` is high enough, so a laptop running an older helper is never offered a switch it would ignore.

- `v >= 2`: model and effort per message, files from Claude, one-tap answers, the stay-awake switch.

## Model and effort

A `user` event body may carry `"model"` (an alias such as `"opus"`, or a full model name) and `"effort"` (`low`, `medium`, `high`, `xhigh`, `max`). The helper passes them to Claude Code as `--model` and `--effort` for that message; anything that is not a plain name is ignored. Without them the laptop's own Claude settings apply. The closing `result` event repeats what was used: `{ ..., "model": "opus", "effort": "high" }`.

The website remembers the choice per chat on the phone and sends it with every message from that chat.

## Files from Claude

During a task Claude can run `remote send <file>... [--caption "text"]`. The helper uploads each file to the private storage bucket `files` (`d<yyyymmdd>/<conversation id>/<random>-<name>`) and adds one event to the chat:

```json
{ "kind": "text",
  "body": { "text": "caption, may be empty",
            "files": [ { "name": "shot.png", "type": "image/png", "size": 184000, "url": "<signed https address>",
                         "image": true, "preview": "<signed address of a smaller JPEG, large pictures only>" } ] } }
```

- `image: true` means the phone can show it inline; other files are offered as a download.
- The addresses are signed and expire when the file is removed: after `keepFilesDays` (default 90; 0 keeps them) in `~/.config/claude-remote/config.json`.
- Up to 6 files per send, 20 MB each. The website only follows `https://` addresses.

## One-tap answers

When Claude ends a reply with a last line `[[answers: Yes | No | Only the website]]` (see `helper/rules.md`), the helper takes the line out of the text and records the answers: `"answers": ["Yes", "No", "Only the website"]` on that `text` event and on the closing `result` event, which also gets `"question": true`. At most four, each up to 60 characters. The website offers them as buttons until something is sent; tapping one sends it as an ordinary message. The website strips the line itself too, in case a reply was recorded by a helper that did not.

## Staying awake

The website may not write to `devices` or `app_settings`, so the switch is kept in the owner's account preferences (Supabase Auth user metadata), which it can: `{ "keep_awake": { "<device id>": false } }`. Missing means on.

The helper reads it with each heartbeat (about every 15 seconds) and holds or releases its wake lock. Whatever the switch says, the lock is released while the laptop is on battery below 10%, and taken again once it is charging or back to 15%. What it is doing is in the health row:

```json
{ "battery": 8, "plugged": false, "charging": false,
  "awake": false, "awake_wanted": true, "awake_low": true, "v": 2, "updated_at": "<iso>" }
```

`awake` is whether the lock is held now, `awake_wanted` the switch as the helper last read it, `awake_low` true when the battery rule is what released it. Releasing the lock does not put the laptop to sleep; it lets the system's own sleep settings apply.
