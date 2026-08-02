-- Shared multiplayer state used by the Vercel deployment.
-- Runtime access is only through the authenticated Supabase Edge Function.
create table if not exists public.game_platform_state (
  id text primary key,
  revision bigint not null default 0,
  data jsonb not null default '{}'::jsonb,
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
