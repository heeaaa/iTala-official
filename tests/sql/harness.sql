create schema if not exists auth;
create table if not exists auth_state(uid uuid, anon boolean);
insert into auth_state values ('11111111-1111-1111-1111-111111111111', false);

-- Stand-in for Supabase's auth.users. Only needed because schema.sql's
-- `games.created_by` and `creation_codes.created_by` carry a real foreign key to
-- it, so any suite that loads those columns needs the referenced table to exist
-- and to contain the uids it writes. Seeded with every uid the suites switch
-- between via auth_state - an FK violation here would otherwise look like a
-- failure in the code under test rather than missing scaffolding.
create table if not exists auth.users (id uuid primary key);
insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('aaaaaaaa-0000-0000-0000-000000000001'),
  ('bbbbbbbb-0000-0000-0000-000000000002'),
  ('cccccccc-0000-0000-0000-000000000003')
on conflict (id) do nothing;
create or replace function auth.uid() returns uuid language sql stable as $$ select uid from auth_state limit 1 $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select jsonb_build_object('is_anonymous',(select anon from auth_state limit 1)) $$;

create table leagues (id text primary key, name text not null, season text not null, kind text not null,
  foul_out_limit int, track_misses boolean, track_turnovers boolean, is_shared boolean, is_closed boolean,
  is_archived boolean, created_at bigint not null);
create table league_members (league_id text not null references leagues(id) on delete cascade,
  user_id uuid not null, role text not null, primary key (league_id, user_id));
create table teams (id text primary key, league_id text not null references leagues(id) on delete cascade,
  name text not null, color text not null, coach text, logo text, team_only boolean not null default false,
  player_ids text[] not null default '{}', updated_at timestamptz not null default now());
create table players (id text primary key, league_id text not null references leagues(id) on delete cascade,
  name text not null, number text, origin_player_id text);
create table games (id text primary key, league_id text not null references leagues(id) on delete cascade,
  home_team_id text not null, away_team_id text not null, status text not null check (status in ('scheduled','live','final')),
  scheduled_at bigint, location text, finished_at bigint, home_on_court text[] not null default '{}',
  away_on_court text[] not null default '{}', period int default 1, attendance text[],
  track_misses boolean, track_turnovers boolean, updated_at timestamptz not null default now());
-- events exists here only so the shipped RLS block (which creates read_all_events
-- and events_write_scorer) can be loaded whole. A suite that never @requires the
-- policies simply leaves it empty.
create table events (id text primary key, league_id text not null references leagues(id) on delete cascade,
  game_id text not null references games(id) on delete cascade, team_id text not null, player_id text,
  type text not null, period int not null, ts bigint not null, note text,
  created_at timestamptz not null default now());
create table profiles (id uuid primary key, is_admin boolean default false);

create or replace function public.is_authed_user() returns boolean language sql stable as $$
  select auth.uid() is not null and not coalesce((auth.jwt()->>'is_anonymous')::boolean,false) $$;
create or replace function public.is_admin() returns boolean language sql stable as $$
  select coalesce((select is_admin from profiles where id=auth.uid()),false) $$;
-- Parameter names below MUST stay identical to schema.sql's. A suite that
-- @requires the real `authz` section loads it on top of these stubs with
-- `create or replace function`, and Postgres refuses to change the name of an
-- input parameter that way - `member_role(p text)` here against
-- `member_role(p_league_id text)` there fails with
-- "cannot change name of input parameter". Renaming these to match is what lets
-- the real definitions override the stubs instead of erroring.
create or replace function public.member_role(p_league_id text) returns text language sql stable as $$
  select role from league_members where league_id=p_league_id and user_id=auth.uid() $$;
create or replace function public.is_shared_rec(p_league_id text) returns boolean language sql stable as $$
  select coalesce((select kind='recreational' and is_shared from leagues where id=p_league_id),false) $$;
create or replace function public.can_score(p_league_id text) returns boolean language sql stable as $$
  select public.is_admin() or public.member_role(p_league_id) is not null
      or (public.is_shared_rec(p_league_id) and public.is_authed_user()) $$;
