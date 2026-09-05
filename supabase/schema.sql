-- iTala — Supabase schema + Row Level Security
-- Run this in the Supabase SQL Editor (Project → SQL → New query).
-- It is idempotent: safe to re-run; existing rows are preserved.

-- =============================================================================
-- 1) PROFILES: per-user role flag
-- =============================================================================
-- Supabase Auth creates a row in auth.users for every sign-in (including anonymous).
-- We mirror that into public.profiles so we can attach an is_admin flag we control.
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);
-- Migration: email + display name (shown in league member lists).
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists name  text;

-- =============================================================================
-- 1b) ADMIN EMAIL ALLOWLIST — Google accounts that are admins automatically
-- =============================================================================
-- Adding/removing an admin is one row here (plus the ADMIN_EMAILS list in
-- src/store/AdminProvider.tsx, which drives the client UI). No policies on
-- this table = it is not readable or writable through the API; only the
-- security-definer functions in this file can touch it.
create table if not exists public.admin_emails (
  email    text primary key,
  added_at timestamptz not null default now()
);
alter table public.admin_emails enable row level security;

insert into public.admin_emails (email) values
  ('abejoharold@gmail.com'),
  ('abejohanna@gmail.com'),
  ('aeronjosephsantos@gmail.com'),
  ('santos.ajhea@gmail.com')
on conflict (email) do nothing;

-- Auto-create a profile row whenever a new auth user is created.
-- Google sign-ins whose email is on the admin_emails allowlist (above) are
-- flagged is_admin from the very first sign-in — no password needed.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, is_admin, email, name)
  values (
    new.id,
    coalesce(
      new.email is not null
      and exists (select 1 from public.admin_emails a where lower(a.email) = lower(new.email)),
      false
    ),
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', new.email)
  )
  on conflict (id) do update set email = excluded.email, name = excluded.name;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Called by the app right after any Google sign-in (and at boot). Promotes the
-- caller to admin if their email is on the allowlist. Deliberately never
-- DEMOTES — the password-elevation backup (elevate_to_admin) also sets
-- is_admin, and demoting here would silently undo it. Returns whether the
-- caller's email is allowlisted.
create or replace function public.sync_admin_role()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  em text;
  allowed boolean;
begin
  if auth.uid() is null then
    return false;
  end if;

  select email into em from auth.users where id = auth.uid();
  allowed := em is not null
    and exists (select 1 from public.admin_emails a where lower(a.email) = lower(em));

  -- Keep the profile's email/name fresh (used in league member lists).
  update public.profiles p
     set email = u.email,
         name  = coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', u.email)
    from auth.users u
   where p.id = auth.uid() and u.id = auth.uid();

  if allowed then
    -- Profile normally exists via the trigger; upsert covers pre-trigger users.
    insert into public.profiles (id, is_admin) values (auth.uid(), true)
    on conflict (id) do update set is_admin = true;
  end if;

  return allowed;
end;
$$;

grant execute on function public.sync_admin_role() to anon, authenticated;

-- =============================================================================
-- 1c) ACCOUNT DELETION — App Store 5.1.1(v) / Google Play policy requirement
-- =============================================================================
-- Any app offering account creation must let users delete the account in-app.
-- Deleting the auth.users row cascades to public.profiles (FK above). League
-- and game data is keyed by league entities, not auth users, so recorded
-- stats, teams, and standings are untouched.
create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

grant execute on function public.delete_own_account() to authenticated;

-- =============================================================================
-- 2) DOMAIN TABLES — mirror the client TypeScript model
-- =============================================================================
-- We use the SAME id strings the client already generates (short base36 ids like
-- 'lmk6f2x9'), stored as text. This means existing local data can be migrated
-- 1:1 without rewriting ids, and offline-created records sync cleanly.

create table if not exists public.leagues (
  id              text primary key,
  name            text not null,
  season          text not null,
  kind            text not null default 'league' check (kind in ('league','recreational')),
  foul_out_limit  int,
  track_misses    boolean,            -- per-league live-tracker setting; null = pre-migration row
  track_turnovers boolean,            -- per-league: show the TOV button (default true)
  is_shared       boolean not null default false, -- shared community drop-in space
  created_at      bigint not null,    -- client's Date.now() value
  updated_at      timestamptz not null default now()
);
-- Migrations for databases created before these columns existed:
alter table public.leagues add column if not exists track_misses boolean;
alter table public.leagues add column if not exists track_turnovers boolean;
-- One-shot migration: the app-wide trackMisses toggle that used to live in
-- app_settings is gone, replaced by leagues.track_misses above. Carry the old
-- global value onto every pre-migration league (null = predates the column)
-- BEFORE dropping the table, or a project whose global was false would silently
-- get miss tracking turned back on for those leagues.
--
-- Guarded by to_regclass so a fresh install, where app_settings never existed,
-- is a clean no-op. Idempotent: a re-run finds no nulls and no table.
do $$
declare legacy_track_misses boolean;
begin
  if to_regclass('public.app_settings') is not null then
    execute $q$ select (value ->> 'trackMisses')::boolean
                  from public.app_settings
                 where key = 'trackMisses' $q$
      into legacy_track_misses;
  end if;

  update public.leagues
     set track_misses = coalesce(track_misses, legacy_track_misses, true)
   where track_misses is null;

  update public.leagues
     set track_turnovers = coalesce(track_turnovers, true)
   where track_turnovers is null;
end $$;

drop table if exists public.app_settings;
alter table public.leagues add column if not exists is_shared boolean not null default false;
alter table public.leagues add column if not exists is_closed boolean not null default false;
alter table public.leagues add column if not exists is_archived boolean not null default false;
alter table public.teams   add column if not exists coach text;
-- Dormant breadcrumb (read by nothing yet): set by league duplication so a
-- future career-profile feature can link the same person across seasons.
-- Deliberately NOT a foreign key — the source league may be deleted later.
alter table public.players add column if not exists origin_player_id text;
-- Post-game attendance: player ids present at the game (null = not recorded;
-- the app then falls back to "played = present").
alter table public.games add column if not exists attendance text[];
-- Per-game stat-tracking overrides for drop-in games (null = inherit the
-- league-level setting; set at creation for rec games so one user's choice
-- never flips settings for everyone in the shared community space).
alter table public.games add column if not exists track_misses boolean;
alter table public.games add column if not exists track_turnovers boolean;
alter table public.games add column if not exists created_by uuid references auth.users(id) on delete set null;

create table if not exists public.teams (
  id           text primary key,
  league_id    text not null references public.leagues(id) on delete cascade,
  name         text not null,
  color        text not null,
  coach           text,
  logo         text,                   -- data URI; small base64 thumbs OK
  team_only    boolean not null default false,
  player_ids   text[] not null default '{}',  -- mirrors Team.playerIds
  updated_at   timestamptz not null default now()
);

create table if not exists public.players (
  id           text primary key,
  league_id    text not null references public.leagues(id) on delete cascade,
  name         text not null,
  number       text,
  updated_at   timestamptz not null default now()
);

create table if not exists public.games (
  id              text primary key,
  league_id       text not null references public.leagues(id) on delete cascade,
  home_team_id    text not null,
  away_team_id    text not null,
  status          text not null check (status in ('scheduled','live','final')),
  scheduled_at    bigint,
  location        text,
  finished_at     bigint,
  home_on_court   text[] not null default '{}',
  away_on_court   text[] not null default '{}',
  period          int default 1,
  updated_at      timestamptz not null default now()
);

create table if not exists public.events (
  id           text primary key,
  league_id    text not null references public.leagues(id) on delete cascade,
  game_id      text not null references public.games(id) on delete cascade,
  team_id      text not null,
  player_id    text,                   -- null for team-level events (timeouts, opponent-as-team)
  type         text not null,          -- EventType union; validated client-side
  period       int not null,
  ts           bigint not null,
  note         text,
  created_at   timestamptz not null default now()
);

create index if not exists events_game_id_idx   on public.events (game_id);
create index if not exists events_league_id_idx on public.events (league_id);
create index if not exists teams_league_id_idx  on public.teams (league_id);
create index if not exists players_league_idx   on public.players (league_id);
create index if not exists games_league_idx     on public.games (league_id);

-- =============================================================================
-- 4) ROW LEVEL SECURITY — read-anywhere, write-admin-only
-- =============================================================================
-- The goal: any signed-in user (including anonymous spectators) can READ every
-- table so they can watch live games. Only users with profiles.is_admin = true
-- can INSERT/UPDATE/DELETE. This replaces the client-side password gate with
-- real server-enforced authorization.

alter table public.profiles      enable row level security;
alter table public.leagues       enable row level security;
alter table public.teams         enable row level security;
alter table public.players       enable row level security;
alter table public.games         enable row level security;
alter table public.events        enable row level security;

-- Helper: returns true if the current auth.uid() is an admin.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- Profiles: each user can read their own row; nobody can change is_admin directly
-- (that's done via the elevate_to_admin function below, which checks the password).
drop policy if exists "read own profile"  on public.profiles;
drop policy if exists "read all profiles" on public.profiles;
create policy "read own profile" on public.profiles for select using (auth.uid() = id);

-- =============================================================================
-- 4b) LEAGUE MEMBERSHIP — per-league owners & scorekeepers
-- =============================================================================
-- Roles per league:
--   owner       — full control of the league: settings, teams, members, delete.
--                 A league can have several owners (co-owners).
--   scorekeeper — runs games: create/edit/finalize games, live stat entry,
--                 add/edit players (late subs). Cannot restructure the league.
-- Super Admins (profiles.is_admin, the email allowlist) bypass membership and
-- can do anything in any league — the platform-support tier.
-- Shared recreational leagues (leagues.is_shared) are writable by ANY signed-in
-- non-anonymous user, no membership needed.

create table if not exists public.league_members (
  league_id text not null references public.leagues(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      text not null check (role in ('owner','scorekeeper')),
  added_at  timestamptz not null default now(),
  primary key (league_id, user_id)
);
alter table public.league_members enable row level security;
drop policy if exists "read own memberships" on public.league_members;
create policy "read own memberships" on public.league_members
  for select using (user_id = auth.uid());
-- All membership mutations go through the security-definer RPCs below.

-- Single-use codes minted by Super Admins; each creates exactly one league.
create table if not exists public.creation_codes (
  code       text primary key,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  used_by    uuid,
  used_at    timestamptz
);
alter table public.creation_codes enable row level security; -- no policies: RPC-only

-- Per-league join codes (one per role); regenerating replaces the code.
create table if not exists public.league_codes (
  league_id text not null references public.leagues(id) on delete cascade,
  role      text not null check (role in ('owner','scorekeeper')),
  code      text not null unique,
  primary key (league_id, role)
);
alter table public.league_codes enable row level security; -- no policies: RPC-only

-- MIGRATION: seed the Super Admins as owners of every pre-existing league
-- (only for admins who have already signed in; supers bypass membership anyway).
insert into public.league_members (league_id, user_id, role)
select l.id, u.id, 'owner'
from public.leagues l
cross join auth.users u
where exists (select 1 from public.admin_emails a where lower(a.email) = lower(u.email))
on conflict do nothing;

-- ---- helpers -----------------------------------------------------------------
-- A real (non-anonymous) signed-in user.
create or replace function public.is_authed_user()
returns boolean language sql stable as $$
  select auth.uid() is not null
     and not coalesce((auth.jwt()->>'is_anonymous')::boolean, false);
$$;

create or replace function public.member_role(p_league_id text)
returns text language sql stable security definer set search_path = public as $$
  select role from public.league_members
  where league_id = p_league_id and user_id = auth.uid();
$$;

-- Shared community drop-in space: writable by any signed-in real user.
create or replace function public.is_shared_rec(p_league_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_shared and kind = 'recreational'
                   from public.leagues where id = p_league_id), false);
$$;

-- Can run games / edit players in this league.
create or replace function public.can_score(p_league_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or public.member_role(p_league_id) is not null
      or (public.is_shared_rec(p_league_id) and public.is_authed_user());
$$;

-- Scoring rights for ONE game. The community drop-in space is a single shared
-- league holding everyone's games, so rights there are per game: only the
-- creator (or a Super Admin) may score. Everywhere else the league rules apply.
--
-- `is_authed_user()` is not redundant. The shared-space branch never consults
-- `can_score`, so it is the only thing standing between an ANONYMOUS session and
-- a game whose created_by happens to equal its uid - and games.created_by is now
-- stamped from auth.uid() by a trigger, so that is no longer a hypothetical
-- combination. Guest sessions watch; they never score.
create or replace function public.can_score_row(p_league_id text, p_created_by uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or case when public.is_shared_rec(p_league_id)
              then public.is_authed_user()
                   and p_created_by is not null and p_created_by = auth.uid()
              else public.can_score(p_league_id) end;
$$;

create or replace function public.can_score_game(p_game_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.can_score_row(g.league_id, g.created_by)
  from public.games g where g.id = p_game_id;
$$;

-- Can restructure this league (settings, teams, members, delete).
create or replace function public.is_owner(p_league_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or public.member_role(p_league_id) = 'owner';
$$;

-- Short human-typable code: 6 chars, no confusable characters.
create or replace function public.gen_code()
returns text language plpgsql volatile as $$
declare
  alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  out_code text := '';
  i int;
begin
  for i in 1..6 loop
    out_code := out_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return out_code;
end $$;

-- ---- policies ------------------------------------------------------------------
-- Read = any signed-in session (spectators). Writes are league-scoped:
--   leagues:  update/delete owner; INSERT only via the create_league RPC
--   teams:    insert/delete owner (or shared rec); update scorekeeper+ (player_ids)
--   players/games/events: scorekeeper+
do $$
declare t text;
begin
  foreach t in array array['leagues','teams','players','games','events']
  loop
    execute format('drop policy if exists "read_all_%1$I"  on public.%1$I;', t);
    execute format('drop policy if exists "write_admin_%1$I" on public.%1$I;', t);
    execute format('create policy "read_all_%1$I" on public.%1$I for select using (auth.uid() is not null);', t);
  end loop;
end $$;

drop policy if exists "leagues_update_owner" on public.leagues;
create policy "leagues_update_owner" on public.leagues for update
  using (public.is_owner(id)) with check (public.is_owner(id));
drop policy if exists "leagues_delete_owner" on public.leagues;
create policy "leagues_delete_owner" on public.leagues for delete
  using (public.is_owner(id));

drop policy if exists "teams_insert" on public.teams;
create policy "teams_insert" on public.teams for insert
  with check (public.can_score(league_id)); -- scorekeepers manage rosters; can_score covers shared rec too
drop policy if exists "teams_update" on public.teams;
create policy "teams_update" on public.teams for update
  using (public.can_score(league_id)) with check (public.can_score(league_id));
drop policy if exists "teams_delete" on public.teams;
create policy "teams_delete" on public.teams for delete
  using (public.is_owner(league_id));

do $$
declare t text;
begin
  foreach t in array array['players']
  loop
    execute format('drop policy if exists "%1$I_write_scorer" on public.%1$I;', t);
    execute format('create policy "%1$I_write_scorer" on public.%1$I for all
                    using (public.can_score(league_id)) with check (public.can_score(league_id));', t);
  end loop;
end $$;

-- Games: per-row check so a community drop-in game is writable only by whoever
-- created it. created_by is stamped server-side - by rec_setup_game on the
-- bundle insert, and by the games_own_creator trigger below on every other
-- write.
--
-- Precisely what that guarantees, because the difference matters to anyone
-- relying on it: an ESTABLISHED creator cannot be REPLACED, in one statement,
-- by a client sending a different uid. It is not an absolute invariant.
-- Clearing is permitted, because `on delete set null` on the auth.users foreign
-- key is an UPDATE and intercepting it would leave rows pointing at deleted
-- accounts - so anyone who may write the row at all can null the column in one
-- statement and stamp a new uid in the next.
--
-- That two-step is inert everywhere it could matter. In the shared space the
-- clear is itself refused, because this policy's WITH CHECK re-evaluates
-- can_score_row(league_id, NULL) on the post-trigger row and an unowned row
-- there belongs to nobody. Everywhere else can_score_row falls through to
-- can_score() and never reads the column. What is left is a Super Admin, who
-- can already write anything, and pre-stamping a normal-league game against a
-- later is_shared flip, for which no client path exists (pinned as X1 in
-- tests/sql/league_roles.test.sql). Closing it properly would mean permitting
-- NULL only when the old uid is gone from auth.users, which costs this trigger
-- its "reads no table, needs no elevated rights" property.
drop policy if exists "games_write_scorer" on public.games;
create policy "games_write_scorer" on public.games for all
  using (public.can_score_row(league_id, created_by))
  with check (public.can_score_row(league_id, created_by));

-- Events inherit their game's scoring rights.
drop policy if exists "events_write_scorer" on public.events;
create policy "events_write_scorer" on public.events for all
  using (public.can_score_game(game_id))
  with check (public.can_score_game(game_id));

-- games.created_by belongs to the SERVER.
--
-- This is not tidiness, it is what makes the policy above usable by the person
-- the policy exists to protect. PostgREST turns `.upsert(row)` into
-- `insert ... on conflict (id) do update set <the payload columns>`, and
-- PostgreSQL applies the INSERT policy's WITH CHECK to the row PROPOSED for
-- insertion - before it discovers that a conflict will send that row down the
-- UPDATE path instead. `gameToRow` in src/sync/sync.ts omits created_by (by
-- design: a client must not be able to set it), so the proposed row carries
-- null, can_score_row sees an unowned row in a shared rec league, and the whole
-- statement is refused with 42501. The STORED row names the caller as its
-- creator and the update alone would have been allowed, but that is never
-- reached. Every lineup, substitution, period, attendance and finish write on a
-- public drop-in game failed exactly that way: the scorekeeper saw a starting
-- five that reverted a second later and a game that would not finish, because
-- the server row still said {} and 'live' and the next snapshot said so too.
--
-- Stamping the caller on INSERT makes the proposed row a legitimate row for
-- that caller, so the statement gets as far as the conflict, where the EXISTING
-- row's created_by decides - which is the rule this schema always meant to
-- apply. A stranger is still refused there; their own new game is still theirs.
--
-- The UPDATE branch keeps an established creator from being overwritten by a
-- client that does send the column: a device with stale local state would
-- otherwise hand the game to whoever wrote last and lock the real creator out
-- for good. It deliberately lets a NULL through, because `on delete set null`
-- on the auth.users foreign key is an UPDATE, and intercepting that would leave
-- the row pointing at an account that no longer exists.
--
-- SECURITY INVOKER on purpose: it reads no table, so it needs no extra rights.
create or replace function public.games_own_creator()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.created_by is null then new.created_by := auth.uid(); end if;
  elsif old.created_by is not null
        and new.created_by is not null
        and new.created_by is distinct from old.created_by then
    new.created_by := old.created_by;
  end if;
  return new;
end $$;
drop trigger if exists games_own_creator on public.games;
create trigger games_own_creator before insert or update on public.games
  for each row execute function public.games_own_creator();

-- ---- RPCs ---------------------------------------------------------------------
-- Super Admins mint single-use league-creation codes.
create or replace function public.create_creation_code()
returns text language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not public.is_admin() then raise exception 'Only a Super Admin can create league codes.'; end if;
  c := public.gen_code();
  insert into public.creation_codes (code, created_by) values (c, auth.uid());
  return c;
end $$;

-- One field for every code. Returns what the code grants:
--   {"type":"create"}                       — valid, unused league-creation code
--   {"type":"joined","league_id":..,"role":..,"league_name":..} — joined a league
-- Raises for invalid/used codes.
create or replace function public.redeem_code(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c text := upper(trim(p_code));
  cc record; lc record; existing text; lname text;
begin
  if not public.is_authed_user() then raise exception 'Sign in to use an invite code.'; end if;

  select * into cc from public.creation_codes where code = c;
  if found then
    if cc.used_by is not null then raise exception 'This code has already been used.'; end if;
    return jsonb_build_object('type', 'create');
  end if;

  select * into lc from public.league_codes where code = c;
  if found then
    select name into lname from public.leagues where id = lc.league_id;
    select role into existing from public.league_members
      where league_id = lc.league_id and user_id = auth.uid();
    if existing = 'owner' then
      -- never downgrade an owner via a scorekeeper code
      return jsonb_build_object('type','joined','league_id',lc.league_id,'role','owner','league_name',lname);
    end if;
    insert into public.league_members (league_id, user_id, role)
    values (lc.league_id, auth.uid(), lc.role)
    on conflict (league_id, user_id) do update set role = excluded.role;
    return jsonb_build_object('type','joined','league_id',lc.league_id,'role',lc.role,'league_name',lname);
  end if;

  raise exception 'Invalid code.';
end $$;

-- League creation. Supers need no code; everyone else consumes a single-use
-- creation code. Recreational containers need no code (personal per user, or
-- the shared community space with p_shared = true).
drop function if exists public.create_league(text,text,text,text,int,boolean,bigint,text,boolean);
drop function if exists public.create_league(text,text,text,text,int,boolean,bigint,text,boolean,boolean);
-- Bulk roster import: inserts every team and its players in ONE round trip /
-- ONE server-side transaction. This is deliberate — dispatching one action per
-- team and per player (as manual entry does) fires that many independent,
-- unawaited network writes; with dozens of players the player inserts can
-- reach the server before their own team's insert lands, hit the team_id FK,
-- and fail silently. A single atomic call makes that race impossible: the
-- team rows exist before any player row is written, in the same transaction.
create or replace function public.bulk_import_roster(p_league_id text, p_teams jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare team jsonb; ply jsonb;
begin
  if not public.can_score(p_league_id) then raise exception 'Scorekeeper access required.'; end if;
  for team in select * from jsonb_array_elements(p_teams) loop
    insert into public.teams (id, league_id, name, color, player_ids)
    values (
      team->>'id', p_league_id,
      coalesce(nullif(team->>'name', ''), 'Team'),
      coalesce(nullif(team->>'color', ''), '#12D7D0'),
      coalesce((select array_agg(p->>'id') from jsonb_array_elements(team->'players') p), '{}')
    )
    -- SCOPED to p_league_id, and not merely for tidiness. This function is
    -- SECURITY DEFINER, so RLS does not run inside it, and it authorises on the
    -- caller-supplied p_league_id while upserting caller-supplied ROW ids. Every
    -- signed-in user holds a league they may write - can_score is true for all
    -- of them on the shared community space - and every id in the database is
    -- readable through the read_all_* policies. Without this clause any user
    -- could name a team in somebody else's league and rewrite its name, colour
    -- and roster; the foreign row keeps its own league_id, so it is a pure
    -- cross-league write that no policy ever sees.
    --
    -- The WHERE makes the conflicting update match zero rows, and the FOUND
    -- check turns that into a refusal rather than a silent no-op:
    -- BULK_IMPORT_ROSTER is in MUST_NOT_FAIL_SILENTLY (src/sync/sync.ts), so a
    -- rejected RPC rolls the local import back and tells the person. A skip
    -- would leave them holding a roster the server never stored.
    on conflict (id) do update set name = excluded.name, color = excluded.color, player_ids = excluded.player_ids
    where public.teams.league_id = p_league_id;
    if not found then
      raise exception 'Team id % already exists in another league.', team->>'id';
    end if;

    for ply in select * from jsonb_array_elements(team->'players') loop
      -- players.name is NOT NULL, and a pasted roster can legitimately contain a
      -- row with a blank or absent name. Inserting it raw meant ONE such row
      -- aborted the entire import with a not-null violation, losing every other
      -- team and player in the same call - while rec_setup_game, doing the same
      -- job on the drop-in path, defaulted it. Same fallback here (N-18).
      insert into public.players (id, league_id, name, number)
      values (ply->>'id', p_league_id,
              coalesce(nullif(ply->>'name', ''), 'Player'),
              nullif(ply->>'number', ''))
      on conflict (id) do update set name = excluded.name, number = excluded.number
      where public.players.league_id = p_league_id;
      if not found then
        raise exception 'Player id % already exists in another league.', ply->>'id';
      end if;
    end loop;
  end loop;
end $$;
grant execute on function public.bulk_import_roster(text,jsonb) to authenticated;

-- Drop-in game setup: league (if new) + both teams + all players + the game in
-- ONE transaction. Previously this was four sequential round trips, which left
-- windows where the server held a PARTIAL bundle (e.g. game row but no teams).
-- A realtime echo arriving mid-sequence made the client pull that partial
-- snapshot and drop the game/teams locally — the "? team name" and the crash
-- when opening the live card. Atomic means partial states never exist.
create or replace function public.rec_setup_game(
  p_league_id text, p_league_name text, p_shared boolean, p_created_at bigint,
  p_game_id text, p_location text, p_track_misses boolean, p_track_turnovers boolean,
  p_teams jsonb
) returns void language plpgsql security definer set search_path = public as $$
declare team jsonb; ply jsonb; home_id text; away_id text; i int := 0;
        existing_league text; existing_creator uuid;
begin
  -- A Super Admin may start a drop-in game without a provider account.
  --
  -- is_authed_user() excludes anonymous sessions, and the backup admin path
  -- (elevate_to_admin, password checked server-side against a bcrypt hash with
  -- attempt throttling) elevates whatever session the device already has -
  -- which is an anonymous one. So a verified Super Admin was refused here while
  -- being granted everything else in this schema, including the blanket
  -- is_admin() write policies. The client agreed with the grant and not with
  -- this line, so the app let them fill in two rosters and then failed on save.
  --
  -- This closes that gap in the direction the rest of the file already points.
  -- It is not a widening of trust: is_admin() reads profiles.is_admin, which
  -- only elevate_to_admin can set, and only on a correct password.
  if not (public.is_authed_user() or public.is_admin()) then
    raise exception 'Sign in to start a drop-in game.';
  end if;

  -- League row first (idempotent). Shared community space is owned by nobody;
  -- a private drop-in space is owned by its creator.
  if not exists (select 1 from public.leagues where id = p_league_id) then
    insert into public.leagues (id, name, season, kind, foul_out_limit, track_misses, track_turnovers, is_shared, created_at)
    values (p_league_id, p_league_name, 'Drop-In', 'recreational', null, true, true, coalesce(p_shared, false), p_created_at);
  end if;

  -- A private space belongs to its creator. Claim it whenever it has no owner
  -- yet, not only when this call created it: a row left behind by an earlier
  -- failed attempt would otherwise have no membership, and every later write
  -- would be rejected by can_score. Only ever claims an UNOWNED space.
  if not coalesce(p_shared, false)
     and not exists (select 1 from public.league_members where league_id = p_league_id) then
    insert into public.league_members (league_id, user_id, role)
    values (p_league_id, auth.uid(), 'owner');
  end if;

  if not public.can_score(p_league_id) then raise exception 'Scorekeeper access required.'; end if;

  -- THE GAME ID MUST NOT ALREADY NAME A ROW THIS CALLER MAY NOT WRITE.
  --
  -- Game ids are minted on the device by uid() in src/lib/format.ts - a base36
  -- clock plus a base36 random - so they are guessable enough to be squatted
  -- ahead of use, and every id already in the database is readable anyway
  -- through the read_all_games policy.
  --
  -- The squat: an attacker inserts a game row under the id the victim is about
  -- to use. The shared community space accepts a new game from any signed-in
  -- user (by design - it is shared), and games_own_creator stamps the attacker
  -- as its creator. The victim's rec_setup_game then took the conflict branch,
  -- left created_by pointing at the attacker, and RETURNED SUCCESSFULLY - after
  -- which every write the victim makes to their own game is refused 42501 by
  -- can_score_row. That is exactly the broken-game symptom this schema just
  -- finished fixing, handed to an attacker.
  --
  -- The cross-league case is the same hole from the other end. This function is
  -- SECURITY DEFINER, so RLS does not run inside it, and it authorised on the
  -- caller-supplied p_league_id while upserting a caller-supplied game id, never
  -- checking the stored row's league. can_score('rec-shared') is true for every
  -- signed-in user, so everyone held a valid p_league_id and could name any game
  -- row in the product, moving it into the shared space and rewriting its teams
  -- and location.
  --
  -- Raising, not skipping: REC_SETUP_GAME is in MUST_NOT_FAIL_SILENTLY
  -- (src/sync/sync.ts), so a rejected RPC rolls the local bundle back and shows
  -- the person an alert, and they can start the game again under a fresh id. A
  -- silent skip would hand them a game the server says belongs to somebody else,
  -- with no message - the same failure in a quieter costume.
  select g.league_id, g.created_by into existing_league, existing_creator
    from public.games g where g.id = p_game_id;
  if existing_league is not null then
    if existing_league <> p_league_id then
      raise exception 'Game id % already exists in another league.', p_game_id;
    elsif not public.can_score_row(existing_league, existing_creator) then
      raise exception 'Game id % was created by someone else.', p_game_id;
    end if;
  end if;

  -- Teams + their players.
  for team in select * from jsonb_array_elements(p_teams) loop
    -- teams.color is NOT NULL — never let a missing color abort the import.
    insert into public.teams (id, league_id, name, color, player_ids)
    values (
      team->>'id', p_league_id,
      coalesce(nullif(team->>'name', ''), 'Team'),
      coalesce(nullif(team->>'color', ''), '#12D7D0'),
      coalesce((select array_agg(p->>'id') from jsonb_array_elements(team->'players') p), '{}')
    )
    -- Scoped to p_league_id for the reason spelled out in bulk_import_roster:
    -- a definer function upserting caller-supplied row ids, with no policy
    -- underneath it, is a cross-league write into any team in the product
    -- unless the conflict update says which league it is allowed to touch.
    on conflict (id) do update set name = excluded.name, color = excluded.color, player_ids = excluded.player_ids
    where public.teams.league_id = p_league_id;
    if not found then
      raise exception 'Team id % already exists in another league.', team->>'id';
    end if;

    for ply in select * from jsonb_array_elements(team->'players') loop
      insert into public.players (id, league_id, name, number)
      values (ply->>'id', p_league_id, coalesce(nullif(ply->>'name', ''), 'Player'), nullif(ply->>'number', ''))
      on conflict (id) do update set name = excluded.name, number = excluded.number
      where public.players.league_id = p_league_id;
      if not found then
        raise exception 'Player id % already exists in another league.', ply->>'id';
      end if;
    end loop;

    if i = 0 then home_id := team->>'id'; else away_id := team->>'id'; end if;
    i := i + 1;
  end loop;

  -- The game last — both team rows now exist in this same transaction.
  insert into public.games (id, league_id, home_team_id, away_team_id, status,
                            scheduled_at, location, home_on_court, away_on_court,
                            period, track_misses, track_turnovers, created_by)
  values (p_game_id, p_league_id, home_id, away_id, 'live',
          p_created_at, nullif(p_location, ''), '{}', '{}',
          1, p_track_misses, p_track_turnovers, auth.uid())
  on conflict (id) do update set home_team_id = excluded.home_team_id,
                                 away_team_id = excluded.away_team_id,
                                 location = excluded.location
  where public.games.league_id = p_league_id
    and public.can_score_row(public.games.league_id, public.games.created_by);
  -- The pre-check above already rejected both of these cases with a message that
  -- names which one it was; repeating the condition at the point of the write is
  -- what stops two concurrent calls interleaving between the check and the
  -- upsert, where neither would see the other's row.
  if not found then
    raise exception 'Game id % is already in use.', p_game_id;
  end if;
end $$;
grant execute on function public.rec_setup_game(text,text,boolean,bigint,text,text,boolean,boolean,jsonb) to authenticated;

create or replace function public.create_league(
  p_id text, p_name text, p_season text, p_kind text,
  p_foul_out int, p_track_misses boolean, p_created_at bigint,
  p_code text default null, p_shared boolean default false,
  p_track_turnovers boolean default true, p_source_league text default null
) returns void language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not public.is_authed_user() then raise exception 'Sign in to create a league.'; end if;
  if exists (select 1 from public.leagues where id = p_id) then return; end if; -- idempotent

  -- Duplicating your own league is not "creating" from scratch — no code needed.
  if p_source_league is not null and public.is_owner(p_source_league) then
    null;
  elsif p_kind <> 'recreational' and not public.is_admin() then
    c := upper(trim(coalesce(p_code, '')));
    if not exists (select 1 from public.creation_codes where code = c and used_by is null) then
      raise exception 'A valid league-creation code from a Super Admin is required.';
    end if;
    update public.creation_codes set used_by = auth.uid(), used_at = now() where code = c;
  end if;

  insert into public.leagues (id, name, season, kind, foul_out_limit, track_misses, track_turnovers, is_shared, created_at)
  values (p_id, p_name, p_season, p_kind, p_foul_out, coalesce(p_track_misses, true),
          coalesce(p_track_turnovers, true), p_kind = 'recreational' and p_shared, p_created_at);

  -- Creator owns it — except the shared community space, which nobody owns.
  if not (p_kind = 'recreational' and p_shared) then
    insert into public.league_members (league_id, user_id, role)
    values (p_id, auth.uid(), 'owner') on conflict do nothing;
  end if;
end $$;

-- Owner tools ---------------------------------------------------------------
create or replace function public.get_league_codes(p_league_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare oc text; sc text;
begin
  if not public.is_owner(p_league_id) then raise exception 'Owners only.'; end if;
  insert into public.league_codes (league_id, role, code) values (p_league_id, 'owner', public.gen_code())
    on conflict (league_id, role) do nothing;
  insert into public.league_codes (league_id, role, code) values (p_league_id, 'scorekeeper', public.gen_code())
    on conflict (league_id, role) do nothing;
  select code into oc from public.league_codes where league_id = p_league_id and role = 'owner';
  select code into sc from public.league_codes where league_id = p_league_id and role = 'scorekeeper';
  return jsonb_build_object('owner', oc, 'scorekeeper', sc);
end $$;

create or replace function public.regenerate_league_code(p_league_id text, p_role text)
returns text language plpgsql security definer set search_path = public as $$
declare c text := public.gen_code();
begin
  if not public.is_owner(p_league_id) then raise exception 'Owners only.'; end if;
  insert into public.league_codes (league_id, role, code) values (p_league_id, p_role, c)
  on conflict (league_id, role) do update set code = excluded.code;
  return c;
end $$;

create or replace function public.list_members(p_league_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner(p_league_id) then raise exception 'Owners only.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', m.user_id, 'role', m.role,
      'name', coalesce(p.name, p.email, 'Unknown'), 'email', p.email
    ) order by m.role, m.added_at)
    from public.league_members m
    left join public.profiles p on p.id = m.user_id
    where m.league_id = p_league_id
  ), '[]'::jsonb);
end $$;

create or replace function public.remove_member(p_league_id text, p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare target_role text; owner_count int;
begin
  if not public.is_owner(p_league_id) then raise exception 'Owners only.'; end if;
  select role into target_role from public.league_members
    where league_id = p_league_id and user_id = p_user_id;
  if target_role = 'owner' then
    select count(*) into owner_count from public.league_members
      where league_id = p_league_id and role = 'owner';
    if owner_count <= 1 then raise exception 'A league must keep at least one owner.'; end if;
  end if;
  delete from public.league_members where league_id = p_league_id and user_id = p_user_id;
end $$;

create or replace function public.my_memberships()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('league_id', league_id, 'role', role)), '[]'::jsonb)
  from public.league_members where user_id = auth.uid();
$$;

grant execute on function public.create_creation_code() to authenticated;
grant execute on function public.redeem_code(text) to authenticated;
grant execute on function public.create_league(text,text,text,text,int,boolean,bigint,text,boolean,boolean,text) to authenticated;
grant execute on function public.get_league_codes(text) to authenticated;
grant execute on function public.regenerate_league_code(text,text) to authenticated;
grant execute on function public.list_members(text) to authenticated;
grant execute on function public.remove_member(text,uuid) to authenticated;
grant execute on function public.my_memberships() to authenticated;

-- Adds a player AND attaches them to their team in ONE transaction. The app
-- previously did this as two writes; a realtime re-pull landing between them
-- hydrated a player that no team claimed yet, making the new roster row
-- vanish for a beat. One transaction = every snapshot is consistent.
create or replace function public.add_player(
  p_league_id text, p_team_id text, p_player_id text, p_name text, p_number text
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_score(p_league_id) then raise exception 'Scorekeeper access required.'; end if;
  -- Scoped to p_league_id. Same shape of hole as the other two definer RPCs: RLS
  -- does not run in here, the authorisation is on the caller-supplied
  -- p_league_id, and p_player_id is a caller-supplied row id. Every signed-in
  -- user can pass can_score('rec-shared'), so an unscoped conflict update let
  -- anybody rename any player in any league in the product. The foreign row's
  -- league_id never changes, so nothing about it is visible as a league write.
  insert into public.players (id, league_id, name, number)
  values (p_player_id, p_league_id, p_name, p_number)
  on conflict (id) do update set name = excluded.name, number = excluded.number
  where public.players.league_id = p_league_id;
  if not found then
    raise exception 'Player id % already exists in another league.', p_player_id;
  end if;
  -- The team update was already league-scoped, and it stays a silent no-op when
  -- it matches nothing. Deliberate, and different from the player upsert above:
  -- a raise here would roll the player insert back with it, losing the player
  -- entirely rather than just its team wiring, which the next full push or pull
  -- repairs. A cross-league team id cannot corrupt anything from here anyway -
  -- the WHERE already refuses it.
  --
  -- (This used to argue that `check` in src/sync/sync.ts would swallow the
  -- error too, since ADD_PLAYER is not in MUST_NOT_FAIL_SILENTLY. That is no
  -- longer true: check now collects row-level refusals into PushOutcome.refused
  -- and the chip turns red. The rollback above is the reason that survives -
  -- and a raise would additionally pin an outbox entry that can never succeed.)
  update public.teams
     set player_ids = array_append(array_remove(player_ids, p_player_id), p_player_id)
   where id = p_team_id and league_id = p_league_id;
end $$;
grant execute on function public.add_player(text,text,text,text,text) to authenticated;

-- =============================================================================
-- 5) ADMIN ELEVATION — hashed, throttled, and never stored in this file
-- =============================================================================
-- This is the emergency backup path to admin. The primary path is the Google /
-- Apple email allowlist in admin_emails; this exists so a Super Admin can get
-- back in when OAuth is unavailable.
--
-- THREAT MODEL — read this before changing anything here.
--
-- elevate_to_admin is granted to `anon`, and it has to be: the app boots into an
-- anonymous session and the hidden unlock gesture has to work before the caller
-- is anybody. The anon key is inlined into the JS bundle by Metro, so it is
-- extractable from any installed copy of the app. Put together, the guess rate an
-- attacker gets against this function is whatever the DATABASE allows — from
-- anywhere on the internet, with no app and no rate limit in front of it.
--
-- So two things are load-bearing:
--
--   1. THE SECRET IS A BCRYPT HASH, and this file does not contain it. A password
--      committed to the repo is a published password: it survives in git history
--      forever, and rewriting history does not un-publish it. It is set once
--      after deploy via set_admin_password() — see DEPLOYMENT.md.
--   2. GUESSING IS THROTTLED AND LOCKS OUT. Without this the function is an
--      online password oracle: unlimited attempts, no delay, no trace.
--
-- Comparison uses crypt(), which is constant-time for a given hash, so a wrong
-- password cannot be distinguished from a right one by timing.

-- pgcrypto supplies crypt()/gen_salt(). Supabase pre-installs it in `extensions`;
-- older projects have it in `public`. Every call below is unqualified and every
-- function sets `search_path = public, extensions`, so it resolves either way.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.admin_secret (
  id            int primary key default 1,
  password_hash text,                    -- bcrypt; null until set_admin_password runs
  updated_at    timestamptz not null default now(),
  check (id = 1)
);
alter table public.admin_secret enable row level security;
-- Note: no policies on admin_secret = nobody can read or write it via the API.
-- Only security-definer functions running as the table owner can access it.

-- ---- upgrade from the old plaintext layout ---------------------------------
-- `create table if not exists` does NOT alter an existing table, so a project
-- created before this change still has the old `password text not null` column
-- and no `password_hash`. Without this block, re-running schema.sql on such a
-- project fails on the insert below and then happily replaces the functions,
-- leaving elevate_to_admin querying a column that does not exist — i.e. a live
-- project where nobody can unlock. schema.sql is documented as safe to re-run,
-- so the migration belongs here rather than in a note someone has to find.
--
-- The existing password is carried across as a hash before the plaintext column
-- is dropped, so the unlock keeps working with the same password and there is no
-- window where admin is locked out. The plaintext then no longer exists in the
-- database or in its backups.
do $$
declare legacy text;
begin
  -- transaction-local, so crypt()/gen_salt() resolve wherever pgcrypto lives
  perform set_config('search_path', 'public, extensions', true);

  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'admin_secret'
                    and column_name = 'password_hash') then
    alter table public.admin_secret add column password_hash text;
  end if;

  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'admin_secret'
                    and column_name = 'updated_at') then
    alter table public.admin_secret add column updated_at timestamptz not null default now();
  end if;

  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'admin_secret'
                and column_name = 'password') then
    execute 'select password from public.admin_secret where id = 1' into legacy;
    if legacy is not null and legacy <> '' then
      update public.admin_secret
         set password_hash = crypt(legacy, gen_salt('bf', 10)), updated_at = now()
       where id = 1 and coalesce(password_hash, '') = '';
      raise notice 'admin_secret: existing password migrated to a bcrypt hash; plaintext column dropped.';
    end if;
    alter table public.admin_secret drop column password;
  end if;
end $$;

-- On a NEW project the row exists but holds no secret, so there is no working
-- password until an operator sets one. That is the safe default: an unset
-- password refuses every attempt (see elevate_to_admin below).
insert into public.admin_secret (id, password_hash) values (1, null)
on conflict (id) do nothing;

-- Failed-attempt ledger, keyed by the calling session. Retained briefly; the
-- lockout window is what it is for.
create table if not exists public.admin_attempts (
  user_id   uuid primary key,
  fails     int  not null default 0,
  last_fail timestamptz,
  locked_until timestamptz
);
alter table public.admin_attempts enable row level security;
-- No policies: the ledger is only ever touched by the definer functions below,
-- so a caller cannot read how close they are or clear their own lockout.

-- Tunables. Five tries then a 15 minute lockout turns an unlimited oracle into
-- roughly 480 guesses a day, which is useless against anything but the password
-- being already known.
create or replace function public.admin_max_fails() returns int
  language sql immutable as $$ select 5 $$;
create or replace function public.admin_lockout() returns interval
  language sql immutable as $$ select interval '15 minutes' $$;
-- Failures older than this stop counting, so an honest typo months ago does not
-- combine with one today to lock a real admin out.
create or replace function public.admin_fail_window() returns interval
  language sql immutable as $$ select interval '1 hour' $$;

-- Set (or change) the admin password. NOT granted to anon or authenticated: run
-- it from the SQL editor / service role only.
--
--   select public.set_admin_password('«the password»');
--
create or replace function public.set_admin_password(new_password text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new_password is null or length(new_password) < 8 then
    raise exception 'Admin password must be at least 8 characters.';
  end if;
  insert into public.admin_secret (id, password_hash, updated_at)
  values (1, crypt(new_password, gen_salt('bf', 10)), now())
  on conflict (id) do update
     set password_hash = excluded.password_hash, updated_at = now();
  -- A password change clears every lockout: the old attempts are moot.
  delete from public.admin_attempts;
end $$;
revoke all on function public.set_admin_password(text) from public, anon, authenticated;

create or replace function public.elevate_to_admin(password_attempt text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uid    uuid := auth.uid();
  stored text;
  rec    public.admin_attempts;
  ok     boolean;
begin
  if uid is null then
    return false; -- must be signed in (anonymous sessions count)
  end if;

  -- Lockout check first, so a locked-out caller costs nothing and learns nothing.
  select * into rec from public.admin_attempts where user_id = uid;
  if rec.locked_until is not null and rec.locked_until > now() then
    raise exception 'Too many attempts. Try again in % minutes.',
      greatest(1, ceil(extract(epoch from (rec.locked_until - now())) / 60))
      using errcode = '55000'; -- object_not_in_prerequisite_state
  end if;

  select password_hash into stored from public.admin_secret where id = 1;

  -- No password configured = no password works. Do not fall through to "true".
  if stored is null or stored = '' then
    return false;
  end if;

  ok := (stored = crypt(password_attempt, stored));

  if not ok then
    -- Count the failure. Failures outside the window start a fresh streak.
    insert into public.admin_attempts (user_id, fails, last_fail)
    values (uid, 1, now())
    on conflict (user_id) do update
       set fails = case
             when public.admin_attempts.last_fail < now() - public.admin_fail_window() then 1
             else public.admin_attempts.fails + 1 end,
           last_fail = now();

    update public.admin_attempts
       set locked_until = now() + public.admin_lockout()
     where user_id = uid and fails >= public.admin_max_fails();

    return false;
  end if;

  -- Success clears the streak.
  delete from public.admin_attempts where user_id = uid;
  update public.profiles set is_admin = true where id = uid;
  return true;
end;
$$;

grant execute on function public.elevate_to_admin(text) to anon, authenticated;

-- Clear a lockout for the calling session. Service role / SQL editor only —
-- exposing this to clients would make the lockout meaningless.
create or replace function public.reset_admin_attempts()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.admin_attempts;
end $$;
revoke all on function public.reset_admin_attempts() from public, anon, authenticated;

create or replace function public.lock_admin()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then return; end if;
  update public.profiles set is_admin = false where id = auth.uid();
end;
$$;

grant execute on function public.lock_admin() to anon, authenticated;

-- =============================================================================
-- 5b) CONTENT REPORTS — private UGC/privacy review queue
-- =============================================================================
-- Reports are never part of the public read model. A signed-in app session may
-- submit through the narrow SECURITY DEFINER RPC below; only Super Admins can
-- read or update the review columns. There is deliberately no delete policy.
create table if not exists public.content_reports (
  id               uuid primary key default gen_random_uuid(),
  reference        text not null unique,
  record_type      text not null check (record_type in ('player','team','game','league')),
  record_id        text not null,
  league_id        text not null,
  team_id          text,
  reporter_user_id uuid not null,
  reason           text not null check (reason in (
    'Incorrect information',
    'Remove personal information',
    'I’m the player, parent or guardian',
    'Inappropriate or abusive content',
    'Unauthorized image',
    'Other privacy concern'
  )),
  explanation      text,
  contact_email    text,
  status           text not null default 'New' check (status in ('New','Reviewing','Resolved','Rejected')),
  resolution_note  text,
  submitted_at     timestamptz not null default now(),
  reviewed_at      timestamptz,
  reviewed_by      uuid
);
create index if not exists content_reports_status_idx on public.content_reports (status, submitted_at);
alter table public.content_reports enable row level security;

drop policy if exists "content_reports_admin_read" on public.content_reports;
drop policy if exists "content_reports_admin_update" on public.content_reports;
create policy "content_reports_admin_read" on public.content_reports
  for select using (public.is_admin());
create policy "content_reports_admin_update" on public.content_reports
  for update using (public.is_admin()) with check (public.is_admin());

revoke all on table public.content_reports from public, anon, authenticated;
grant select, update on table public.content_reports to authenticated;

-- Optional request IDs keep legacy clients working and deduplicate retries.
alter table public.content_reports add column if not exists request_id text;
create unique index if not exists content_reports_request_idx
  on public.content_reports (reporter_user_id, request_id);
-- Remove the old overload to avoid ambiguous PostgREST resolution.
drop function if exists public.submit_content_report(text,text,text,text,text,text,text);
create or replace function public.submit_content_report(
  p_record_type text,
  p_record_id text,
  p_league_id text,
  p_team_id text,
  p_reason text,
  p_explanation text default null,
  p_contact_email text default null,
  p_request_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  ref text;
  submitted timestamptz := now();
  actual_league text;
  previous_report public.content_reports%rowtype;
begin
  if uid is null then raise exception 'An app session is required.'; end if;
  if p_request_id is not null then
    if length(p_request_id) not between 1 and 128 then raise exception 'Invalid request ID.'; end if;
    -- A timed-out request can still commit. Serialize concurrent retries.
    perform pg_advisory_xact_lock(hashtextextended(uid::text || ':' || p_request_id, 0));
    select * into previous_report
      from public.content_reports where reporter_user_id = uid and request_id = p_request_id;
    if found then
      if previous_report.record_type is distinct from p_record_type
         or previous_report.record_id is distinct from p_record_id
         or previous_report.league_id is distinct from p_league_id
         or previous_report.team_id is distinct from p_team_id
         or previous_report.reason is distinct from p_reason
         or previous_report.explanation is distinct from nullif(btrim(coalesce(p_explanation, '')), '')
         or previous_report.contact_email is distinct from nullif(lower(btrim(coalesce(p_contact_email, ''))), '')
      then raise exception 'The report request ID was already used for different content.'; end if;
      return jsonb_build_object('reference', previous_report.reference, 'submitted_at', previous_report.submitted_at);
    end if;
    submitted := now();
  end if;
  if p_record_type not in ('player','team','game','league') then raise exception 'Unsupported record type.'; end if;
  if p_reason not in (
    'Incorrect information', 'Remove personal information',
    'I’m the player, parent or guardian', 'Inappropriate or abusive content',
    'Unauthorized image', 'Other privacy concern'
  ) then raise exception 'Unsupported report reason.'; end if;
  if length(coalesce(p_explanation, '')) > 2000 then raise exception 'Explanation is too long.'; end if;
  if length(coalesce(p_contact_email, '')) > 254 then raise exception 'Contact email is too long.'; end if;
  if nullif(btrim(coalesce(p_contact_email, '')), '') is not null
     and btrim(p_contact_email) !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  then raise exception 'Enter a valid contact email or leave it blank.'; end if;

  if p_record_type = 'league' then
    select id into actual_league from public.leagues where id = p_record_id;
  elsif p_record_type = 'team' then
    select league_id into actual_league from public.teams where id = p_record_id;
  elsif p_record_type = 'game' then
    select league_id into actual_league from public.games where id = p_record_id;
  else
    select league_id into actual_league from public.players where id = p_record_id;
  end if;
  if actual_league is null or actual_league <> p_league_id then
    raise exception 'The reported record could not be found in that league.';
  end if;
  if p_team_id is not null and not exists (
    select 1 from public.teams t
     where t.id = p_team_id and t.league_id = actual_league
       and (p_record_type <> 'player' or p_record_id = any(t.player_ids))
  ) then raise exception 'The team context is invalid.'; end if;

  -- Human-readable but non-sequential: it is safe to show to the reporter and
  -- does not disclose report volume.
  ref := 'ITR-' || to_char(submitted at time zone 'UTC', 'YYYYMMDD') || '-'
      || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  insert into public.content_reports (
    reference, record_type, record_id, league_id, team_id, reporter_user_id,
    reason, explanation, contact_email, submitted_at, request_id
  ) values (
    ref, p_record_type, p_record_id, actual_league, p_team_id, uid,
    p_reason, nullif(btrim(coalesce(p_explanation, '')), ''),
    nullif(lower(btrim(coalesce(p_contact_email, ''))), ''), submitted, p_request_id
  );

  return jsonb_build_object('reference', ref, 'submitted_at', submitted);
end;
$$;
revoke all on function public.submit_content_report(text,text,text,text,text,text,text,text) from public;
grant execute on function public.submit_content_report(text,text,text,text,text,text,text,text) to anon, authenticated;

-- =============================================================================
-- 6) REALTIME — publish event changes so live games stream to spectators
-- =============================================================================
-- The supabase_realtime publication ships with the project; we add our tables.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='events') then
    alter publication supabase_realtime add table public.events;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='games') then
    alter publication supabase_realtime add table public.games;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='leagues') then
    alter publication supabase_realtime add table public.leagues;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='teams') then
    alter publication supabase_realtime add table public.teams;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='players') then
    alter publication supabase_realtime add table public.players;
  end if;
end $$;

-- =============================================================================
-- 6b) SPONSOR PROMOS — Super-Admin-managed marketing cards (e.g. BPBL Clothing)
-- =============================================================================
-- Small table of sponsor promos shown on Home (rotating), the FinalScore
-- screen, and the spectator live view. Images are stored as compressed data
-- URIs for V1 (same approach as team logos); migrate to Storage if the library
-- grows. Public read (everyone sees promos); Super-Admin-only writes.
create table if not exists public.promos (
  id           text primary key,
  sponsor_name text,
  title        text not null,
  tagline      text,
  image        text,            -- data URI (compressed) or null
  link         text,            -- optional tap-through URL
  active       boolean not null default true,
  show_on_home boolean not null default false,
  taps         integer not null default 0,
  created_at   bigint not null
);
alter table public.promos add column if not exists show_on_home boolean not null default false;
alter table public.promos enable row level security;

drop policy if exists "promos_read_all"   on public.promos;
drop policy if exists "promos_write_admin" on public.promos;
-- Anyone signed in (incl. anonymous spectators) can read promos.
create policy "promos_read_all" on public.promos
  for select using (auth.uid() is not null);
-- Only Super Admins may insert/update/delete.
create policy "promos_write_admin" on public.promos
  for all using (public.is_admin()) with check (public.is_admin());

-- Tap counter: any signed-in user may increment taps (for sponsor ROI), but
-- nothing else. SECURITY DEFINER so the bump bypasses the admin-only write
-- policy while still only ever touching the taps column.
create or replace function public.bump_promo_tap(p_id text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.promos set taps = taps + 1 where id = p_id;
$$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'promos'
  ) then
    alter publication supabase_realtime add table public.promos;
  end if;
end $$;

-- =============================================================================
-- 7) PING — keeps the project from auto-pausing after 7 idle days
-- =============================================================================
-- An external scheduler (GitHub Actions / UptimeRobot) calls this function to
-- register activity. Safe for anonymous callers — it does nothing destructive.
create or replace function public.ping()
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select now();
$$;

grant execute on function public.ping() to anon, authenticated;
