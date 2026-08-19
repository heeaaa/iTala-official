-- iTala v2 :: complete schema, generated from supabase/migrations/
-- Paste this whole file into the Supabase SQL editor and run it once.
-- It is safe to re-run: every statement is idempotent.
--
-- It does NOT set the admin password. See supabase/README.md for that,
-- deliberately, so no password ever lives in this repository.

-- ===========================================================================
-- 20260819090000_extensions_and_profiles.sql
-- ===========================================================================
-- iTala v2 :: 0001 :: extensions, profiles, shared helpers
--
-- Every function here is `security definer` with an explicit `search_path`.
-- That is deliberate hardening: without a pinned search_path a definer
-- function can be tricked into calling an attacker's shadowed object.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- profiles: one row per auth user, including anonymous ones.
-- `is_admin` IS the entire authorisation model.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table public.profiles is
  'One row per auth user. is_admin is flipped only by the security-definer RPCs; there is no write policy, so no client can set it directly.';

-- Created automatically for every new auth user, anonymous ones included.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Keeps updated_at honest. v1 declared these columns and never maintained
-- them, which made them look like optimistic-concurrency tokens when they
-- were not. Here they are genuinely maintained, purely as a debugging aid.
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- is_admin(): the predicate behind every write policy.
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- ---------------------------------------------------------------------------
-- can_write(): the ONLY predicate any write policy calls.
--
-- Today it ignores its argument and asks one global question. When per-user
-- accounts and league membership arrive, this function consults a memberships
-- table and every policy in the database starts enforcing per-league roles
-- without a single policy being rewritten. That is the whole point of the
-- indirection: one function to change, not fifty policies.
-- ---------------------------------------------------------------------------
create or replace function public.can_write(p_league_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin();
$$;

comment on function public.can_write(text) is
  'Write predicate for every domain table. Ignores p_league_id today; becomes a per-league membership check when invite-code accounts ship.';

-- ---------------------------------------------------------------------------
-- ping(): exists solely so the keep-alive job can register activity and stop
-- a free-tier project auto-pausing after 7 idle days. Deliberately harmless.
-- ---------------------------------------------------------------------------
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

-- ===========================================================================
-- 20260819090100_admin_auth.sql
-- ===========================================================================
-- iTala v2 :: 0002 :: the shared admin secret, hashed and rate limited
--
-- v1 stored this password in plaintext, duplicated it as a hardcoded constant
-- in the client, and granted the checking RPC to `anon` with no rate limiting,
-- no lockout and no attempt logging. The anon key ships inside the app binary,
-- so that RPC was callable by anyone, from anywhere, at any rate. A short
-- shared secret was trivially brute-forceable.
--
-- v2: bcrypt, database only, with lockout. The plaintext exists nowhere in
-- this repository. See supabase/README.md for how to set it.

-- ---------------------------------------------------------------------------
-- admin_secret: a singleton table with RLS ON and ZERO POLICIES.
--
-- In Postgres, RLS enabled with no policies means no API caller can read or
-- write it at all. Only security-definer functions running as the table owner
-- can touch it. That empty policy set is intentional; do not "fix" it.
-- ---------------------------------------------------------------------------
create table if not exists public.admin_secret (
  id            int primary key default 1 check (id = 1),
  password_hash text not null,
  updated_at    timestamptz not null default now()
);

alter table public.admin_secret enable row level security;
revoke all on public.admin_secret from anon, authenticated;

-- ---------------------------------------------------------------------------
-- admin_attempts: per-caller failure counter driving lockout. Also RLS on,
-- zero policies, for the same reason.
-- ---------------------------------------------------------------------------
create table if not exists public.admin_attempts (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  failed_count    int not null default 0,
  window_started  timestamptz,
  locked_until    timestamptz,
  last_attempt_at timestamptz not null default now()
);

alter table public.admin_attempts enable row level security;
revoke all on public.admin_attempts from anon, authenticated;

-- Tunables. Five wrong guesses inside fifteen minutes buys a fifteen minute
-- lockout, which turns an online brute force into something that would take
-- longer than the heat death of a basketball season.
create or replace function public.admin_max_attempts() returns int
  language sql immutable as $$ select 5 $$;
create or replace function public.admin_window() returns interval
  language sql immutable as $$ select interval '15 minutes' $$;
create or replace function public.admin_lockout() returns interval
  language sql immutable as $$ select interval '15 minutes' $$;

-- ---------------------------------------------------------------------------
-- elevate_to_admin(): check the shared password and, on success, mark this
-- caller admin.
--
-- Returns jsonb rather than v1's bare boolean so the client can distinguish
-- "wrong password" from "locked out" from "no session" and say something
-- useful. A wrong password is still HTTP 200; it is a successful call that
-- reports failure.
-- ---------------------------------------------------------------------------
create or replace function public.elevate_to_admin(password_attempt text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid     uuid := auth.uid();
  v_row     public.admin_attempts%rowtype;
  v_hash    text;
  v_ok      boolean;
  v_now     timestamptz := now();
  v_remain  int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'no_session');
  end if;

  insert into public.admin_attempts (user_id) values (v_uid)
  on conflict (user_id) do nothing;

  select * into v_row from public.admin_attempts where user_id = v_uid for update;

  -- Locked out. Report how long is left rather than silently failing.
  if v_row.locked_until is not null and v_row.locked_until > v_now then
    return jsonb_build_object(
      'ok', false,
      'reason', 'locked',
      'retry_after_seconds', ceil(extract(epoch from (v_row.locked_until - v_now)))::int
    );
  end if;

  -- The failure window has expired, so start counting again.
  if v_row.window_started is null or v_row.window_started < v_now - public.admin_window() then
    update public.admin_attempts
       set failed_count = 0, window_started = v_now, locked_until = null
     where user_id = v_uid;
    v_row.failed_count := 0;
  end if;

  select password_hash into v_hash from public.admin_secret where id = 1;
  if v_hash is null then
    -- No password has been set on this project yet. Fail closed, loudly.
    return jsonb_build_object('ok', false, 'reason', 'not_configured');
  end if;

  v_ok := (v_hash = extensions.crypt(password_attempt, v_hash));

  if v_ok then
    update public.admin_attempts
       set failed_count = 0, window_started = null, locked_until = null, last_attempt_at = v_now
     where user_id = v_uid;
    update public.profiles set is_admin = true where id = v_uid;
    return jsonb_build_object('ok', true);
  end if;

  update public.admin_attempts
     set failed_count    = v_row.failed_count + 1,
         window_started  = coalesce(window_started, v_now),
         last_attempt_at = v_now,
         locked_until    = case
           when v_row.failed_count + 1 >= public.admin_max_attempts()
           then v_now + public.admin_lockout()
           else null
         end
   where user_id = v_uid
   returning failed_count into v_row.failed_count;

  if v_row.failed_count >= public.admin_max_attempts() then
    return jsonb_build_object(
      'ok', false,
      'reason', 'locked',
      'retry_after_seconds', ceil(extract(epoch from public.admin_lockout()))::int
    );
  end if;

  v_remain := public.admin_max_attempts() - v_row.failed_count;
  return jsonb_build_object('ok', false, 'reason', 'wrong_password', 'attempts_remaining', v_remain);
end;
$$;

-- ---------------------------------------------------------------------------
-- lock_admin(): drop back to spectator on this device.
-- ---------------------------------------------------------------------------
create or replace function public.lock_admin()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  update public.profiles set is_admin = false where id = auth.uid();
end;
$$;

grant execute on function public.elevate_to_admin(text) to anon, authenticated;
grant execute on function public.lock_admin() to anon, authenticated;

-- The tunables and the hash itself are never callable from the API.
revoke execute on function public.admin_max_attempts() from anon, authenticated;
revoke execute on function public.admin_window() from anon, authenticated;
revoke execute on function public.admin_lockout() from anon, authenticated;

-- ===========================================================================
-- 20260819090200_domain_tables.sql
-- ===========================================================================
-- iTala v2 :: 0003 :: the domain
--
-- IDs are text and are generated by the CLIENT before any network call, so a
-- record created offline has its permanent identity immediately and syncs
-- cleanly. Timestamps that the app reasons about are bigint epoch
-- milliseconds, round-tripped exactly as the client wrote them; the
-- timestamptz columns are server-side bookkeeping the client never reads.

-- ---------------------------------------------------------------------------
-- leagues: the top-level container and the only unit of isolation.
-- v1 kept trackMisses in a global app_settings table shared by every league on
-- every device. It is a per-league property: a competitive league and a
-- Tuesday pickup run should not share a data-richness policy.
-- ---------------------------------------------------------------------------
create table if not exists public.leagues (
  id                 text primary key,
  name               text not null,
  season             text not null,
  kind               text not null default 'league' check (kind in ('league', 'recreational')),
  foul_out_limit     int  not null default 5 check (foul_out_limit between 1 and 10),
  regulation_periods int  not null default 4 check (regulation_periods in (2, 4)),
  track_misses       boolean not null default true,
  track_turnovers    boolean not null default false,
  created_at         bigint not null,
  updated_at         timestamptz not null default now()
);

comment on column public.leagues.season is
  'A free-text label such as "Spring 2026". NOT a date range: there is no rollover and no archiving.';
comment on column public.leagues.foul_out_limit is
  'FIBA is 5, NBA is 6. v1 capped this to 5 at read time to defend against legacy rows; v2 honours it.';

-- ---------------------------------------------------------------------------
-- teams. Soft-deleted, so history stays resolvable and the foreign keys
-- pointing at them stay valid.
-- ---------------------------------------------------------------------------
create table if not exists public.teams (
  id          text primary key,
  league_id   text not null references public.leagues (id) on delete cascade,
  name        text not null,
  color       text not null,
  logo_url    text,
  player_ids  text[] not null default '{}',
  archived_at bigint,
  deleted_at  bigint,
  updated_at  timestamptz not null default now()
);

comment on column public.teams.player_ids is
  'ORDERED. This is the roster display order and the default starting five. Order is meaningful; do not sort it.';
comment on column public.teams.logo_url is
  'A URL into Supabase Storage. v1 stored base64 data URIs inline in this row, which inflated every fetch.';
comment on column public.teams.archived_at is
  'Drop-in teams are archived a few days after their last game and hidden from roster pickers. Their games and box scores are kept forever.';

-- ---------------------------------------------------------------------------
-- players. Also soft-deleted: a removed player must still resolve by name in
-- historical box scores, rather than surfacing as the literal string "Player"
-- the way v1 did.
-- ---------------------------------------------------------------------------
create table if not exists public.players (
  id         text primary key,
  league_id  text not null references public.leagues (id) on delete cascade,
  name       text not null,
  number     text,
  person_id  text,
  deleted_at bigint,
  updated_at timestamptz not null default now()
);

comment on column public.players.number is
  'Jersey number as TEXT, deliberately. "00" and "0" are different numbers on a real roster.';
comment on column public.players.person_id is
  'Reserved for a future cross-league person identity. Nothing reads it yet; the column exists now because adding it later is expensive.';

-- ---------------------------------------------------------------------------
-- games. Note the real foreign keys to teams. v1 had none here, so deleting a
-- team left dangling games that crashed the live screen when opened.
--
-- The cascade from teams exists so that deleting a LEAGUE cleans up in one
-- pass. The app never hard-deletes a team; it sets deleted_at.
-- ---------------------------------------------------------------------------
create table if not exists public.games (
  id            text primary key,
  league_id     text not null references public.leagues (id) on delete cascade,
  home_team_id  text not null references public.teams (id) on delete cascade,
  away_team_id  text not null references public.teams (id) on delete cascade,
  status        text not null check (status in ('live', 'final')),
  scheduled_at  bigint,
  location      text,
  finished_at   bigint,
  home_on_court text[] not null default '{}',
  away_on_court text[] not null default '{}',
  period        int not null default 1 check (period between 1 and 9),
  updated_at    timestamptz not null default now(),
  constraint games_distinct_teams check (home_team_id <> away_team_id)
);

comment on column public.games.finished_at is
  'Set only on the transition to final. Standings ordering and streak derivation depend on it.';

-- ---------------------------------------------------------------------------
-- events: THE LEDGER. Append-only, immutable once written, and the only
-- source of numeric truth in the entire system.
--
-- v1 left the type column with no check constraint and validated client-side.
-- With no legacy strings to tolerate, the database enforces its own enum.
-- ---------------------------------------------------------------------------
create table if not exists public.events (
  id         text primary key,
  league_id  text not null references public.leagues (id) on delete cascade,
  game_id    text not null references public.games (id) on delete cascade,
  team_id    text not null references public.teams (id) on delete cascade,
  player_id  text references public.players (id) on delete set null,
  type       text not null check (type in (
    'fg2_make', 'fg2_miss',
    'fg3_make', 'fg3_miss',
    'ft_make',  'ft_miss',
    'reb', 'ast', 'stl', 'blk', 'tov', 'pf',
    'timeout'
  )),
  period     int not null check (period between 1 and 9),
  ts         bigint not null,
  note       text,
  created_at timestamptz not null default now()
);

comment on table public.events is
  'The atomic unit of truth. Box scores, scores, standings and career stats are folds over this table and are never stored.';
comment on column public.events.player_id is
  'NULL is MEANINGFUL, not missing: it marks a team-level event such as a timeout. Team-level rows must still appear in team totals.';
comment on column public.events.id is
  'Client-generated. This primary key is the idempotency guard that makes a replayed insert safe and double-logging impossible.';

-- ---------------------------------------------------------------------------
-- Indexes, each serving a named access path.
-- ---------------------------------------------------------------------------
create index if not exists teams_league_id_idx   on public.teams (league_id);
create index if not exists players_league_id_idx on public.players (league_id);
create index if not exists games_league_id_idx   on public.games (league_id);
create index if not exists events_league_id_idx  on public.events (league_id);
-- By far the hottest path: every box score, line score, team-foul and
-- foul-out computation filters events by game.
create index if not exists events_game_id_idx    on public.events (game_id);
-- Not used by the client today, which fetches and filters in memory, but the
-- spectator web view queries a single player's history directly.
create index if not exists events_player_id_idx  on public.events (player_id);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['leagues', 'teams', 'players', 'games'] loop
    execute format('drop trigger if exists set_updated_at_%1$s on public.%1$I', t);
    execute format(
      'create trigger set_updated_at_%1$s before update on public.%1$I
         for each row execute function public.set_updated_at()', t);
  end loop;
end;
$$;

-- ===========================================================================
-- 20260819090300_rls_policies.sql
-- ===========================================================================
-- iTala v2 :: 0004 :: row-level security
--
-- THIS IS THE ONLY REAL ENFORCEMENT IN THE SYSTEM. Every isAdmin check in the
-- client is cosmetic and the client knows it.
--
-- Three roles fall out of the policies below:
--   anonymous-unauthenticated  reads nothing  (every policy needs auth.uid())
--   signed-in spectator        reads everything, writes nothing
--   admin                      reads and writes everything
--
-- Note what is deliberately absent: there is no per-league read restriction.
-- Any signed-in user, including anyone who installs the app and gets an
-- anonymous session, can read every league in the database. That is coherent
-- for one organisation running its own project, and it is the single largest
-- constraint on this design. Making it per-league is a data-model change, not
-- a feature. It is written down here so nobody has to rediscover it.

alter table public.profiles enable row level security;
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select using (auth.uid() = id);
-- NO write policy on profiles, deliberately. is_admin can only be changed by
-- the security-definer RPCs, never by a client.

-- Domain tables: read for any signed-in user, write gated by can_write().
do $$
declare t text;
begin
  foreach t in array array['leagues', 'teams', 'players', 'games', 'events'] loop
    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists "read_all_%1$s" on public.%1$I', t);
    execute format(
      'create policy "read_all_%1$s" on public.%1$I
         for select using (auth.uid() is not null)', t);

    execute format('drop policy if exists "write_%1$s" on public.%1$I', t);
    if t = 'leagues' then
      execute format(
        'create policy "write_%1$s" on public.%1$I
           for all using (public.can_write(id)) with check (public.can_write(id))', t);
    else
      execute format(
        'create policy "write_%1$s" on public.%1$I
           for all using (public.can_write(league_id)) with check (public.can_write(league_id))', t);
    end if;
  end loop;
end;
$$;

-- ===========================================================================
-- 20260819090400_realtime.sql
-- ===========================================================================
-- iTala v2 :: 0005 :: realtime publication
--
-- v2 APPLIES realtime payloads rather than using them as a bare "something
-- changed" signal. v1 discarded the payload and re-downloaded five entire
-- tables, including every base64 logo, on every change, including its own
-- writes echoing back to itself.
--
-- The default replica identity (primary key) is enough: a DELETE payload
-- carries the id, which is all the client needs to remove the row locally.

do $$
declare t text;
begin
  foreach t in array array['leagues', 'teams', 'players', 'games', 'events'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;

