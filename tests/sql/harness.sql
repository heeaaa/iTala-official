create schema if not exists auth;
create table if not exists auth_state(uid uuid, anon boolean);
insert into auth_state values ('11111111-1111-1111-1111-111111111111', false);
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
create table profiles (id uuid primary key, is_admin boolean default false);

create or replace function public.is_authed_user() returns boolean language sql stable as $$
  select auth.uid() is not null and not coalesce((auth.jwt()->>'is_anonymous')::boolean,false) $$;
create or replace function public.is_admin() returns boolean language sql stable as $$
  select coalesce((select is_admin from profiles where id=auth.uid()),false) $$;
create or replace function public.member_role(p text) returns text language sql stable as $$
  select role from league_members where league_id=p and user_id=auth.uid() $$;
create or replace function public.is_shared_rec(p text) returns boolean language sql stable as $$
  select coalesce((select kind='recreational' and is_shared from leagues where id=p),false) $$;
create or replace function public.can_score(p text) returns boolean language sql stable as $$
  select public.is_admin() or public.member_role(p) is not null
      or (public.is_shared_rec(p) and public.is_authed_user()) $$;
