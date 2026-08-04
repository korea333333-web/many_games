-- Shared multiplayer state used by the Vercel deployment.
-- Runtime access is only through the authenticated Supabase Edge Function.
create table if not exists public.game_platform_state (
  id text primary key,
  revision bigint not null default 0,
  data jsonb not null default '{}'::jsonb,
  last_topics text[] not null default array['lobby']::text[],
  last_origin text,
  updated_at timestamptz not null default now()
);

alter table public.game_platform_state enable row level security;
revoke all on table public.game_platform_state from anon, authenticated;

drop policy if exists "deny direct game state access" on public.game_platform_state;
create policy "deny direct game state access"
on public.game_platform_state
for all
to anon, authenticated
using (false)
with check (false);

insert into public.game_platform_state (id, revision, data)
values (
  'global',
  0,
  '{"players":{},"rooms":{},"members":{},"sessions":{},"messages":[],"nextMessageId":1,"lastMaintenanceAt":0}'::jsonb
)
on conflict (id) do nothing;

create schema if not exists private;
revoke all on schema private from public;

create or replace function private.broadcast_game_platform_state_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  topic text;
begin
  foreach topic in array coalesce(new.last_topics, array[]::text[]) loop
    if topic ~ '^(lobby|room:[a-zA-Z0-9_-]{1,80})$' then
      perform realtime.send(
        jsonb_build_object('revision', new.revision, 'origin', new.last_origin),
        'state-changed',
        topic,
        false
      );
    end if;
  end loop;
  return new;
end;
$$;

revoke execute on function private.broadcast_game_platform_state_change() from public, anon, authenticated;

drop trigger if exists game_platform_state_realtime on public.game_platform_state;
create trigger game_platform_state_realtime
after update of revision on public.game_platform_state
for each row
when (old.revision is distinct from new.revision)
execute function private.broadcast_game_platform_state_change();
