# Claude Remote

Control Claude Code on a laptop at home from your phone: send tasks, watch them run, stop them, and get a notification when they finish.

```
phone (website on Vercel)  <->  Supabase (login, database, live updates)  <->  helper on the laptop  ->  Claude Code
```

Neither side connects to the other directly. Both talk to Supabase, so nothing on the home network is opened to the internet.

## What is in here

| Folder | What it is |
|---|---|
| `web/` | The website you open on the phone (Next.js). Holds no secrets. |
| `helper/` | The `remote` command that runs on each laptop. |
| `helper/rules.md` | Standing rules Claude gets on every remote task. Edit this to change how it behaves. |
| `helper/src/guard.js` | Safety net that refuses a short list of catastrophic shell commands. |
| `supabase/schema.sql` | The database tables and access rules. |
| `docs/CONTRACT.md` | How the website and the helper talk through the database. |

## First-time setup

1. **Supabase**: create a free account at supabase.com and a new project. Open SQL Editor, paste all of `supabase/schema.sql`, press Run.
2. **This laptop**: in a terminal, run `remote setup`. It asks for the project URL and the two API keys (dashboard: Project Settings > API Keys), creates your account (the only one that can ever exist), and writes `web/.env.local`.
3. **Website**: in `web/`, run `npx vercel login`, then `npx vercel --prod`. Add the two values from `web/.env.local` as environment variables in the Vercel project, and redeploy.
4. **Phone**: open the Vercel address in Safari, Share > Add to Home Screen, open it from the home screen, log in, and turn on notifications in Settings.

## Daily use

| Command | What it does |
|---|---|
| `remote on` | Makes this laptop the active one. It stays awake while on, unless Stay awake is switched off in the app. Any other laptop finishes its current task and steps down. |
| `remote off` | Stops taking tasks here. Running tasks are stopped. |
| `remote status` | Shows which laptop is on. |
| `remote logs` | Shows recent helper activity (`-f` to follow). |
| `remote notify` | Sends a test notification to the phone. |
| `remote send <file>` | Shows a picture or file in the chat on the phone. Claude runs this during a task. |

Leave the laptop plugged in with the lid open. A MacBook sleeps when the lid closes, whatever the helper does.

## How tasks behave

- **The phone is only a window.** Tasks run on the laptop. Closing the app or locking the phone changes nothing; a notification arrives when a task finishes, fails, or ends with a question, and when the laptop's battery is low.
- **Several tasks at once.** Up to three work at the same time; more wait their turn. Messages inside one chat always run one after another, in order.
- **Background work.** When a reply leaves something running in the background (a server, a long build), the chat still counts as finished. Sending the next message in that chat stops that background work first. Things you ask to keep running are started detached and survive.
- **Long chats.** Claude summarizes older parts of a long chat on its own when it runs out of room. A long chat costs more of the plan's limit per message than a fresh one, so start a new task for a new topic.
- **Model and effort.** A new task, or any chat from its menu, can pick the model and how hard Claude thinks. "Default" is whatever Claude Code on the laptop is set to.
- **Files from Claude.** Claude can send pictures and files into the chat (screenshots, documents). They are kept in the project's private storage for 90 days (`keepFilesDays`, 0 keeps them).
- **One-tap answers.** When Claude ends with a question that has a few obvious answers, they appear as buttons above the message box.
- **Staying awake.** The laptop card has a Stay awake switch. On, the helper keeps the laptop from sleeping on its own. Off, the laptop sleeps when it normally would, and then takes no tasks until someone wakes it. On battery below 10% it is let sleep whatever the switch says. On a Mac, closing the lid still sleeps it until you run `helper/setup-lid.sh` once (asks for your password); after that, Stay awake also covers a closed lid, on battery too.
- **Storage.** Command output older than 30 days is cleared from the database so the free tier does not fill up; the conversation text stays. Change `keepOutputDays` in `~/.config/claude-remote/config.json` (0 keeps everything).
- **Free tier.** Supabase pauses a free project after about a week with no activity. A laptop that is on counts as activity. If every laptop was off for a week, un-pause the project in the Supabase dashboard.

## Adding a second laptop

1. Install Node 22 or newer and Claude Code, and run `claude` once to log in.
2. Copy this project there, then in `helper/` run `npm install` and `npm link`.
3. Run `remote setup` with the same Supabase values. It finds the existing account and only asks for a laptop name.
4. Run `remote on` on whichever laptop should take the tasks.

Chats stay readable on the phone, but a chat can only be continued on the laptop that ran it, and each laptop has its own files.

## How Claude is kept in line

Remote tasks run with full access and no approval prompts. Two things stand in for the prompts:

- `helper/rules.md` is added to Claude's instructions on every remote task: no spending, no paid services without approval, no deleting files it did not create, nothing sent to other people unasked, keep the laptop reachable. It is instructions, so it shapes behavior but cannot physically prevent anything.
- `helper/src/guard.js` runs before every shell command and blocks a short list outright: recursive deletes of top-level folders, disk erasing, shutting down or sleeping the laptop, stopping the helper, and `git clean` in a folder that is not its own repository.

Remote tasks never use an API key from the environment; they run on the Claude login of the laptop.

## Tests

`cd helper && npm test` runs the helper's tests: the safety net, the output parser, and the task loop against an in-memory fake database.

## Not built yet

- A second login step (authenticator code).
- Approving individual actions from the phone.
- Scheduled tasks, viewing changed files, saved prompts.
- Starting the helper automatically at login.
