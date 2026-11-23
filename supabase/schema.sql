-- claude-remote database schema.
-- Paste this whole file into the Supabase SQL Editor and press Run. Safe to run more than once.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- One row per laptop. Only one is `active` at a time; the phone talks to that one.
create table if not exists public.devices (
  id          text primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  platform    text,
  home        text,
  folders     jsonb not null default '[]'::jsonb,   -- [{ "path": "/Users/x/Developer/app", "label": "Developer/app" }]
  active      boolean not null default false,
  running     integer not null default 0,            -- tasks in progress right now
  last_seen   timestamptz,
  created_at  timestamptz not null default now()
);

-- One row per chat with Claude.
create table if not exists public.conversations (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title              text not null default 'New task',
  cwd                text,                            -- folder on the laptop; null means the home folder
  device_id          text references public.devices (id) on delete set null,  -- laptop that owns it, set on first run
  claude_session_id  uuid,                            -- set by the helper on first run
  status             text not null default 'idle' check (status in ('idle', 'queued', 'running', 'error')),
  stop_requested     boolean not null default false,
  last_text          text,                            -- short preview for the list
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Append-only timeline of a conversation.
--   kind         body
--   user         { "text": "..." }                       state: pending -> running -> done | cancelled
--   text         { "text": "..." }                       Claude's reply (markdown)
--   tool         { "id": "...", "name": "Bash", "summary": "npm test", "input": { ... } }
--   tool_result  { "tool_id": "...", "text": "...", "is_error": false }
--   result       { "ok": true, "duration_ms": 1234, "turns": 3 }
--   error        { "text": "...", "limit": false }       limit = stopped by the usage limit
--   notice       { "text": "..." }                       helper messages such as "Stopped"
create table if not exists public.events (
  id               bigint generated always as identity primary key,
  conversation_id  uuid not null references public.conversations (id) on delete cascade,
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind             text not null check (kind in ('user', 'text', 'tool', 'tool_result', 'result', 'error', 'notice')),
  state            text check (state in ('pending', 'running', 'done', 'cancelled')),
  body             jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists events_conversation_idx on public.events (conversation_id, id);
create index if not exists events_pending_idx on public.events (id) where kind = 'user' and state = 'pending';
create index if not exists conversations_updated_idx on public.conversations (updated_at desc);

-- Phone/browser push subscriptions.
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);

-- Values the website may read (for example the public push key).
create table if not exists public.app_settings (
  key    text primary key,
  value  jsonb not null
);

-- Values only the laptop helper may read (for example the private push key).
create table if not exists public.app_secrets (
  key    text primary key,
  value  jsonb not null
);

-- ---------------------------------------------------------------------------
-- Housekeeping triggers
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists conversations_touch on public.conversations;
create trigger conversations_touch before update on public.conversations
  for each row execute function public.touch_updated_at();

-- Only one account can ever exist. The first one is created by `remote setup`;
-- every later sign-up is rejected by the database itself.
create or replace function public.single_user_only() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from auth.users) >= 1 then
    raise exception 'Sign-ups are closed';
  end if;
  return new;
end $$;

drop trigger if exists single_user_only on auth.users;
create trigger single_user_only before insert on auth.users
  for each row execute function public.single_user_only();

-- ---------------------------------------------------------------------------
-- Access rules: the signed-in owner sees only their own rows; nobody else sees anything.
-- The laptop helper uses the secret key, which bypasses these rules.
-- ---------------------------------------------------------------------------

alter table public.devices            enable row level security;
alter table public.conversations      enable row level security;
alter table public.events             enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.app_settings       enable row level security;
alter table public.app_secrets        enable row level security;

drop policy if exists devices_read on public.devices;
create policy devices_read on public.devices
  for select to authenticated using (user_id = auth.uid());

drop policy if exists conversations_all on public.conversations;
create policy conversations_all on public.conversations
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists events_read on public.events;
create policy events_read on public.events
  for select to authenticated using (user_id = auth.uid());

-- The website may only add the owner's own messages; everything else is written by the helper.
drop policy if exists events_send on public.events;
create policy events_send on public.events
  for insert to authenticated with check (user_id = auth.uid() and kind = 'user' and state = 'pending');

drop policy if exists push_all on public.push_subscriptions;
create policy push_all on public.push_subscriptions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists settings_read on public.app_settings;
create policy settings_read on public.app_settings
  for select to authenticated using (true);

-- app_secrets has no policies on purpose: only the secret key can read it.

revoke all on public.devices, public.conversations, public.events,
  public.push_subscriptions, public.app_settings, public.app_secrets from anon;
revoke all on public.app_secrets from authenticated;

grant select on public.devices, public.app_settings to authenticated;
grant select, insert, update, delete on public.conversations, public.push_subscriptions to authenticated;
grant select, insert on public.events to authenticated;
grant all on public.devices, public.conversations, public.events,
  public.push_subscriptions, public.app_settings, public.app_secrets to service_role;

-- ---------------------------------------------------------------------------
-- Live updates
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['devices', 'conversations', 'events'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
