-- @requires: is_admin, games_created_by, authz, rls, games_creator, rec_setup, admin
--
-- WHO MAY WRITE A GAME ROW, per league kind, exercised through ROW-LEVEL
-- SECURITY rather than through the helper functions behind it.
--
-- This suite is CHARACTERISATION, not a new feature. It was written while a
-- creator-only rule was being considered for private drop-in spaces, and it is
-- being kept after that idea was dropped, because the thing it pins down is the
-- thing such a change would silently break: outside the SHARED community space,
-- `games.created_by` must have NO bearing on who may write the row. Membership
-- decides, exactly as it did before created_by existed.
--
-- That matters more than it sounds. created_by is now stamped on EVERY game by
-- the games_own_creator trigger, including normal-league and private drop-in
-- games, and the games policy reads that column on every write. So the column is
-- populated and in the authorisation path everywhere, and only one branch of
-- can_score_row is supposed to consult it. If the creator-only branch ever
-- widened past `is_shared_rec`, every league in the product would start
-- rejecting its own owners and scorekeepers on games somebody else opened - and
-- nothing in the tree caught that before this file.
--
-- The rule being pinned:
--
--   recreational + shared, created_by set    -> that uid only, or is_admin()
--   recreational + shared, created_by null   -> is_admin() only
--   recreational + private, any created_by   -> league membership, or is_admin()
--   anything else, any created_by            -> league membership, or is_admin()
--
-- Shared-space coverage lives in community_game_writes.test.sql and
-- community_creator_only.test.sql; this file covers the other three rows and the
-- boundary between them.
--
-- Every check runs `set role authenticated` before the statement under test. The
-- table owner bypasses RLS, and a suite that forgets this passes without testing
-- anything. Fixture rows written as the owner are marked as fixtures.
--
-- Section order is load order: games_created_by before authz (can_score_game
-- reads the column), authz before rls (the policies call it), games_created_by
-- before games_creator (the trigger writes the column).

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

create table t_results (n serial primary key, ok boolean, label text, detail text);
create or replace function t_report(label text, cond boolean, detail text default null)
returns void language plpgsql as $$
begin
  insert into t_results (ok, label, detail)
  values (coalesce(cond, false), label,
          case when coalesce(cond, false) then null
               else coalesce(detail, case when cond is null then 'condition evaluated to null' end) end);
end $$;

-- Run one statement and report what the server made of it, instead of letting
-- the first refusal abort the suite. '00000' is success; '42501' is the RLS
-- refusal (insufficient_privilege).
create or replace function t_try(stmt text) returns text language plpgsql as $$
begin
  execute stmt;
  return '00000';
exception when others then
  return sqlstate;
end $$;

-- Supabase grants these to `authenticated` at the project level, so schema.sql
-- does not. Without them every check below would fail on a plain privilege error
-- and never reach a policy.
grant usage on schema auth to authenticated;
grant select on auth_state to authenticated;
grant select, insert, update, delete
  on public.leagues, public.teams, public.players, public.games, public.events
  to authenticated;

insert into auth.users (id) values
  ('dddddddd-0000-0000-0000-000000000004'),
  ('99999999-0000-0000-0000-000000000009')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- FIXTURES (owner-written; RLS is bypassed here on purpose - these are the
-- world the assertions run in, not assertions themselves).
--
--   A = owner of both leagues        B = scorekeeper of both leagues
--   C = Super Admin via profiles.is_admin (the email/db path)
--   D = a signed-in user with no membership anywhere
-- ---------------------------------------------------------------------------
insert into public.leagues (id, name, season, kind, foul_out_limit, track_misses,
                            track_turnovers, is_shared, is_closed, is_archived, created_at)
values ('lgN',  'BPBL',                 'S3',      'league',       5,    true, true, false, false, false, 1720000000000),
       ('recP', 'Private Drop-In Games','Drop-In', 'recreational', null, true, true, false, false, false, 1720000000000);

insert into public.league_members (league_id, user_id, role) values
  ('lgN',  'aaaaaaaa-0000-0000-0000-000000000001', 'owner'),
  ('lgN',  'bbbbbbbb-0000-0000-0000-000000000002', 'scorekeeper'),
  ('recP', 'aaaaaaaa-0000-0000-0000-000000000001', 'owner'),
  ('recP', 'bbbbbbbb-0000-0000-0000-000000000002', 'scorekeeper');

insert into public.teams (id, league_id, name, color, player_ids) values
  ('tN1','lgN','Joyboys North','#12D7D0','{pN1}'),
  ('tN2','lgN','Philcan Grind','#C7F000','{pN2}'),
  ('tP1','recP','Reds','#FF4D4F','{pP1}'),
  ('tP2','recP','Blues','#12D7D0','{pP2}');
insert into public.players (id, league_id, name, number) values
  ('pN1','lgN','Juan A','17'), ('pN2','lgN','Juan B','9'),
  ('pP1','recP','Ana','1'),    ('pP2','recP','Ben','2');

insert into public.profiles (id, is_admin) values ('cccccccc-0000-0000-0000-000000000003', true)
on conflict (id) do update set is_admin = true;

-- ===========================================================================
-- NORMAL LEAGUE - owners and scorekeepers, on games they did NOT create.
--
-- The games are created THROUGH RLS by their creator, so the trigger stamps a
-- real, non-null created_by. That is the whole point: the checks that follow are
-- only meaningful if the column is populated. A fixture written as the owner
-- with created_by left null would make every check below pass for the wrong
-- reason.
-- ===========================================================================
update auth_state set uid = 'bbbbbbbb-0000-0000-0000-000000000002', anon = false;
set role authenticated;
select t_try($q$
  insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at, period)
    values ('gN_byB','lgN','tN1','tN2','live',1720000100000,1)
$q$) as code \gset
reset role;
select t_report('N1 a normal-league SCOREKEEPER can create a game', :'code' = '00000',
                'refused with SQLSTATE ' || :'code');

update auth_state set uid = 'aaaaaaaa-0000-0000-0000-000000000001', anon = false;
set role authenticated;
select t_try($q$
  insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at, period)
    values ('gN_byA','lgN','tN1','tN2','live',1720000110000,1)
$q$) as code \gset
reset role;
select t_report('N2 a normal-league OWNER can create a game', :'code' = '00000',
                'refused with SQLSTATE ' || :'code');

do $$
declare a uuid; b uuid;
begin
  select created_by into a from public.games where id = 'gN_byA';
  select created_by into b from public.games where id = 'gN_byB';
  perform t_report('N3 both normal-league games carry a real created_by',
                   a = 'aaaaaaaa-0000-0000-0000-000000000001'
                     and b = 'bbbbbbbb-0000-0000-0000-000000000002',
                   'gN_byA=' || coalesce(a::text,'null') || ' gN_byB=' || coalesce(b::text,'null')
                     || ' - if these are null the checks below prove nothing, because '
                     || 'a creator-only rule would let a null through on the membership branch');
end $$;

-- The owner, on the SCOREKEEPER's game. This is the assertion that a
-- creator-only rule leaking out of the shared-space branch would break.
update auth_state set uid = 'aaaaaaaa-0000-0000-0000-000000000001', anon = false;
set role authenticated;
select t_try($q$
  insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at,
      location, finished_at, home_on_court, away_on_court, period, attendance,
      track_misses, track_turnovers)
    values ('gN_byB','lgN','tN1','tN2','live',1720000100000,'Southridge',null,
            '{pN1}','{pN2}',2,null,true,true)
    on conflict (id) do update set
      status = excluded.status, location = excluded.location,
      home_on_court = excluded.home_on_court, away_on_court = excluded.away_on_court,
      period = excluded.period
$q$) as code \gset
reset role;
select t_report('N4 an OWNER can score a normal-league game they did NOT create',
                :'code' = '00000', 'refused with SQLSTATE ' || :'code');

set role authenticated;
select t_try($q$
  update public.games set status = 'final', finished_at = 1720000900000 where id = 'gN_byB'
$q$) as code \gset
reset role;
do $$
declare s text; f bigint; c uuid;
begin
  select status, finished_at, created_by into s, f, c from public.games where id = 'gN_byB';
  perform t_report('N5 ...and finish it', s = 'final' and f is not null,
                   'status=' || coalesce(s,'null') || ' finished_at=' || coalesce(f::text,'null'));
  perform t_report('N6 ...without becoming its creator',
                   c = 'bbbbbbbb-0000-0000-0000-000000000002',
                   'created_by is now ' || coalesce(c::text,'null')
                     || ' - the trigger must not hand the row to whoever wrote last');
end $$;

-- The scorekeeper, on the OWNER's game.
update auth_state set uid = 'bbbbbbbb-0000-0000-0000-000000000002', anon = false;
set role authenticated;
select t_try($q$
  insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at,
      location, home_on_court, away_on_court, period, track_misses, track_turnovers)
    values ('gN_byA','lgN','tN1','tN2','live',1720000110000,'Southridge',
            '{pN1}','{pN2}',3,true,true)
    on conflict (id) do update set
      location = excluded.location, home_on_court = excluded.home_on_court,
      away_on_court = excluded.away_on_court, period = excluded.period
$q$) as code \gset
reset role;
select t_report('N7 a SCOREKEEPER can score a normal-league game they did NOT create',
                :'code' = '00000', 'refused with SQLSTATE ' || :'code');

set role authenticated;
select t_try($q$
  update public.games set status = 'final', finished_at = 1720000910000 where id = 'gN_byA'
$q$) as code \gset
reset role;
do $$
declare s text; c uuid; h text[];
begin
  select status, created_by, home_on_court into s, c, h from public.games where id = 'gN_byA';
  perform t_report('N8 ...and finish it', s = 'final', 'status=' || coalesce(s,'null'));
  perform t_report('N9 ...and the lineup they saved really landed',
                   h = '{pN1}'::text[], 'server holds home_on_court=' || coalesce(h::text,'null'));
  perform t_report('N10 ...without becoming its creator',
                   c = 'aaaaaaaa-0000-0000-0000-000000000001',
                   'created_by is now ' || coalesce(c::text,'null'));
end $$;

-- Events follow the game, through can_score_game -> can_score_row. A
-- creator-only leak would take live stat entry down with the game row.
set role authenticated;
select t_try($q$
  insert into public.events (id, league_id, game_id, team_id, player_id, type, period, ts, note)
    values ('eN1','lgN','gN_byA','tN1','pN1','3pm',1,1720000120000,null)
$q$) as code \gset
reset role;
select t_report('N11 a SCOREKEEPER can log a stat on a game they did not create',
                :'code' = '00000', 'refused with SQLSTATE ' || :'code');

-- Roster rights. The user's description of the role split: scorekeepers edit
-- team names and add/edit players; owners do that and the settings too.
set role authenticated;
select t_try($q$ update public.teams set name = 'Joyboys N' where id = 'tN1' $q$) as code \gset
reset role;
select t_report('N12 a SCOREKEEPER can rename a team', :'code' = '00000',
                'refused with SQLSTATE ' || :'code');

set role authenticated;
select t_try($q$
  insert into public.players (id, league_id, name, number) values ('pN3','lgN','Late Sub','23')
$q$) as code \gset
reset role;
select t_report('N13 a SCOREKEEPER can add a player', :'code' = '00000',
                'refused with SQLSTATE ' || :'code');

set role authenticated;
select t_try($q$ update public.players set name = 'Juan A. Cruz' where id = 'pN1' $q$) as code \gset
reset role;
select t_report('N14 a SCOREKEEPER can edit a player', :'code' = '00000',
                'refused with SQLSTATE ' || :'code');

update auth_state set uid = 'aaaaaaaa-0000-0000-0000-000000000001', anon = false;
set role authenticated;
select t_try($q$ update public.teams set color = '#000000' where id = 'tN2' $q$) as code \gset
reset role;
select t_report('N15 an OWNER can write teams too', :'code' = '00000',
                'refused with SQLSTATE ' || :'code');

set role authenticated;
select t_try($q$ update public.players set number = '00' where id = 'pN2' $q$) as code \gset
reset role;
select t_report('N16 an OWNER can write players too', :'code' = '00000',
                'refused with SQLSTATE ' || :'code');

set role authenticated;
select t_try($q$ update public.leagues set foul_out_limit = 6 where id = 'lgN' $q$) as code \gset
reset role;
do $$
declare v int;
begin
  select foul_out_limit into v from public.leagues where id = 'lgN';
  perform t_report('N17 an OWNER can change league settings', v = 6,
                   'foul_out_limit=' || coalesce(v::text,'null'));
end $$;

-- The other half of the role split: a scorekeeper does NOT restructure the
-- league. An UPDATE filtered out by RLS reports no error and touches no rows, so
-- the value is what has to be asserted, not the SQLSTATE.
update auth_state set uid = 'bbbbbbbb-0000-0000-0000-000000000002', anon = false;
set role authenticated;
select t_try($q$ update public.leagues set foul_out_limit = 99 where id = 'lgN' $q$) as code \gset
reset role;
do $$
declare v int;
begin
  select foul_out_limit into v from public.leagues where id = 'lgN';
  perform t_report('N18 a SCOREKEEPER cannot change league settings', v = 6,
                   'foul_out_limit is now ' || coalesce(v::text,'null')
                     || ' - an RLS-filtered UPDATE reports success and writes nothing, '
                     || 'so only the stored value proves this');
end $$;

set role authenticated;
select t_try($q$ delete from public.teams where id = 'tN2' $q$) as code \gset
reset role;
do $$
begin
  perform t_report('N19 a SCOREKEEPER cannot delete a team',
                   exists (select 1 from public.teams where id = 'tN2'),
                   'the team is gone - an RLS-filtered DELETE also reports no error');
end $$;

-- A signed-in outsider has nothing in a normal league.
update auth_state set uid = 'dddddddd-0000-0000-0000-000000000004', anon = false;
set role authenticated;
select t_try($q$
  insert into public.games (id, league_id, home_team_id, away_team_id, status, period)
    values ('gN_byA','lgN','tN1','tN2','live',9)
    on conflict (id) do update set period = excluded.period
$q$) as code \gset
reset role;
select t_report('N20 a non-member cannot write a normal-league game', :'code' = '42501',
                'expected 42501, got ' || :'code');

-- ===========================================================================
-- PRIVATE DROP-IN SPACE - members-only, and membership is what decides.
--
-- The user was asked directly whether scorekeepers invited into a private
-- drop-in space should lose the ability to score games they did not start. The
-- answer was no: scorekeepers are exempted, they keep scoring rights. So a
-- private drop-in space behaves exactly like a normal league here, and these
-- checks exist to keep it that way.
-- ===========================================================================
update auth_state set uid = 'aaaaaaaa-0000-0000-0000-000000000001', anon = false;
set role authenticated;
select t_try($q$
  insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at, period)
    values ('gP_byA','recP','tP1','tP2','live',1720000200000,1)
$q$) as code \gset
reset role;
select t_report('P1 the private-space OWNER can create a game', :'code' = '00000',
                'refused with SQLSTATE ' || :'code');

update auth_state set uid = 'bbbbbbbb-0000-0000-0000-000000000002', anon = false;
set role authenticated;
select t_try($q$
  insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at, period)
    values ('gP_byB','recP','tP1','tP2','live',1720000210000,1)
$q$) as code \gset
reset role;
select t_report('P2 an invited SCOREKEEPER can create a game in a private space',
                :'code' = '00000', 'refused with SQLSTATE ' || :'code');

do $$
declare a uuid; b uuid;
begin
  select created_by into a from public.games where id = 'gP_byA';
  select created_by into b from public.games where id = 'gP_byB';
  perform t_report('P3 private drop-in games carry a real created_by as well',
                   a = 'aaaaaaaa-0000-0000-0000-000000000001'
                     and b = 'bbbbbbbb-0000-0000-0000-000000000002',
                   'gP_byA=' || coalesce(a::text,'null') || ' gP_byB=' || coalesce(b::text,'null')
                     || ' - the trigger stamps every game, not only shared-space ones');
end $$;

-- The two checks the revised requirement turns on.
set role authenticated;
select t_try($q$
  update public.games set home_on_court = '{pP1}', period = 2, status = 'final',
                          finished_at = 1720000800000
   where id = 'gP_byA'
$q$) as code \gset
reset role;
do $$
declare s text; h text[]; c uuid;
begin
  select status, home_on_court, created_by into s, h, c from public.games where id = 'gP_byA';
  perform t_report('P4 a SCOREKEEPER can score and finish a private-space game they did NOT create',
                   s = 'final' and h = '{pP1}'::text[],
                   'status=' || coalesce(s,'null') || ' home_on_court=' || coalesce(h::text,'null')
                     || ' - the user asked for scorekeepers to be exempted');
  perform t_report('P5 ...without becoming its creator',
                   c = 'aaaaaaaa-0000-0000-0000-000000000001',
                   'created_by is now ' || coalesce(c::text,'null'));
end $$;

update auth_state set uid = 'aaaaaaaa-0000-0000-0000-000000000001', anon = false;
set role authenticated;
select t_try($q$
  update public.games set status = 'final', finished_at = 1720000810000, away_on_court = '{pP2}'
   where id = 'gP_byB'
$q$) as code \gset
reset role;
do $$
declare s text; c uuid;
begin
  select status, created_by into s, c from public.games where id = 'gP_byB';
  perform t_report('P6 the OWNER can score and finish a private-space game the scorekeeper created',
                   s = 'final', 'status=' || coalesce(s,'null'));
  perform t_report('P7 ...without becoming its creator',
                   c = 'bbbbbbbb-0000-0000-0000-000000000002',
                   'created_by is now ' || coalesce(c::text,'null'));
end $$;

set role authenticated;
select t_try($q$
  insert into public.events (id, league_id, game_id, team_id, player_id, type, period, ts, note)
    values ('eP1','recP','gP_byB','tP1','pP1','2pm',1,1720000220000,null)
$q$) as code \gset
reset role;
select t_report('P8 events follow the same membership rule in a private space',
                :'code' = '00000', 'refused with SQLSTATE ' || :'code');

-- A private drop-in game written before created_by existed. Membership still
-- decides; the null must not close the row the way it does in the shared space.
-- Fixture: written as the owner with created_by left null on purpose.
insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at, created_by)
  values ('gP_legacy','recP','tP1','tP2','live',1719000000000,null);
update auth_state set uid = 'bbbbbbbb-0000-0000-0000-000000000002', anon = false;
set role authenticated;
select t_try($q$
  update public.games set home_on_court = '{pP1}' where id = 'gP_legacy'
$q$) as code \gset
reset role;
do $$
declare h text[];
begin
  select home_on_court into h from public.games where id = 'gP_legacy';
  perform t_report('P9 a legacy private-space game (created_by null) is still writable by a member',
                   h = '{pP1}'::text[],
                   'home_on_court=' || coalesce(h::text,'null')
                     || ' - a games-in-progress lockout on real devices is what this prevents');
end $$;

-- And a private space is still members-only.
update auth_state set uid = 'dddddddd-0000-0000-0000-000000000004', anon = false;
set role authenticated;
select t_try($q$
  update public.games set period = 9 where id = 'gP_byA'
$q$) as code \gset
reset role;
do $$
declare p int;
begin
  select period into p from public.games where id = 'gP_byA';
  perform t_report('P10 a non-member cannot write a private drop-in game', p is distinct from 9,
                   'period is now ' || coalesce(p::text,'null')
                     || ' - a filtered UPDATE reports no error, so the value is the evidence');
end $$;

-- ===========================================================================
-- THE BOUNDARY. is_shared is the ONLY thing that switches created_by from
-- inert to authoritative. Flipping it on an existing private space silently
-- converts every game in it to creator-only and locks the other members out.
--
-- This is a GUARD, not a bug report: nothing in the app flips is_shared today.
-- It is here because the column is the entire hinge of the rule, and the next
-- person to add an "make this space public" feature needs this to fail in front
-- of them rather than in production.
-- ===========================================================================
update public.leagues set is_shared = true where id = 'recP';   -- fixture, owner-written
update auth_state set uid = 'bbbbbbbb-0000-0000-0000-000000000002', anon = false;
set role authenticated;
select t_try($q$ update public.games set period = 4 where id = 'gP_byA' $q$) as code \gset
reset role;
do $$
declare p int;
begin
  select period into p from public.games where id = 'gP_byA';
  perform t_report('X1 flipping is_shared makes created_by authoritative and locks a member out',
                   p is distinct from 4,
                   'period is now ' || coalesce(p::text,'null')
                     || ' - if this ever passes, is_shared no longer selects the creator-only rule');
end $$;
update public.leagues set is_shared = false where id = 'recP';  -- put it back

-- ===========================================================================
-- SUPER ADMIN, BOTH PATHS.
--
--   1. profiles.is_admin set directly - the Google/Apple email allowlist path,
--      where handle_new_user flags the row on first sign-in.
--   2. elevate_to_admin - the backup password path, checked server-side against
--      a bcrypt hash. It elevates whatever session the device already has, which
--      in practice is an ANONYMOUS one.
--
-- Both must be able to write any game anywhere, and neither may take the row's
-- creator with it.
-- ===========================================================================
update auth_state set uid = 'cccccccc-0000-0000-0000-000000000003', anon = false;
set role authenticated;
select t_try($q$ update public.games set period = 4 where id = 'gN_byB' $q$) as code \gset
reset role;
do $$
declare p int; c uuid;
begin
  select period, created_by into p, c from public.games where id = 'gN_byB';
  perform t_report('A1 a db-flagged Super Admin can write a normal-league game', p = 4,
                   'period=' || coalesce(p::text,'null'));
  perform t_report('A2 ...without changing its creator',
                   c = 'bbbbbbbb-0000-0000-0000-000000000002',
                   'created_by is now ' || coalesce(c::text,'null'));
end $$;

set role authenticated;
select t_try($q$ update public.games set period = 5 where id = 'gP_byB' $q$) as code \gset
reset role;
do $$
declare p int;
begin
  select period into p from public.games where id = 'gP_byB';
  perform t_report('A3 ...and a private drop-in game they are not a member of', p = 5,
                   'period=' || coalesce(p::text,'null'));
end $$;

-- The password path, end to end: an ANONYMOUS session, a real bcrypt check, and
-- then the write. set_admin_password is revoked from anon/authenticated, so it
-- runs here as the table owner - which is exactly how an operator sets it, from
-- the SQL editor.
select public.set_admin_password('correct horse battery staple');
update auth_state set uid = '99999999-0000-0000-0000-000000000009', anon = true;
-- The profile row is a FIXTURE standing in for handle_new_user, which creates
-- one on every sign-in (anonymous sessions included) in the real project.
-- elevate_to_admin ends with `update public.profiles set is_admin = true`, an
-- UPDATE and not an upsert - with no row it returns true and grants nothing.
-- The harness has no auth.users insert trigger, so the row has to be made here.
insert into public.profiles (id, is_admin) values ('99999999-0000-0000-0000-000000000009', false)
on conflict (id) do nothing;

do $$
declare elevated boolean;
begin
  begin
    elevated := public.elevate_to_admin('wrong password');
  exception when others then elevated := null;
  end;
  perform t_report('A4 the wrong password does not elevate', elevated is false,
                   'elevate_to_admin returned ' || coalesce(elevated::text,'null'));
  perform t_report('A4b ...and is_admin() still says no', public.is_admin() is false,
                   'is_admin() returned ' || coalesce(public.is_admin()::text,'null'));
end $$;

do $$
declare elevated boolean;
begin
  elevated := public.elevate_to_admin('correct horse battery staple');
  perform t_report('A5 the correct password elevates an anonymous session', elevated is true,
                   'elevate_to_admin returned ' || coalesce(elevated::text,'null'));
  perform t_report('A6 ...and is_admin() now agrees', public.is_admin() is true,
                   'is_admin() returned ' || coalesce(public.is_admin()::text,'null'));
end $$;

set role authenticated;
select t_try($q$
  update public.games set status = 'final', finished_at = 1720000999000 where id = 'gP_byA'
$q$) as code \gset
reset role;
do $$
declare s text; f bigint; c uuid;
begin
  select status, finished_at, created_by into s, f, c from public.games where id = 'gP_byA';
  -- finished_at, not status: P4 already finished this game, so asserting the
  -- status alone would pass even if this write had been refused.
  perform t_report('A7 a password-elevated Super Admin can finish a private drop-in game',
                   s = 'final' and f = 1720000999000,
                   'status=' || coalesce(s,'null') || ' finished_at=' || coalesce(f::text,'null')
                     || ' - and note the session is ANONYMOUS: '
                     || 'is_admin() is the only reason this is allowed');
  perform t_report('A8 ...without changing its creator',
                   c = 'aaaaaaaa-0000-0000-0000-000000000001',
                   'created_by is now ' || coalesce(c::text,'null'));
end $$;

set role authenticated;
select t_try($q$ update public.games set period = 6 where id = 'gN_byA' $q$) as code \gset
reset role;
do $$
declare p int;
begin
  select period into p from public.games where id = 'gN_byA';
  perform t_report('A9 ...and a normal-league game', p = 6, 'period=' || coalesce(p::text,'null'));
end $$;

-- Locking back down must actually take the rights away again.
do $$
begin
  perform public.lock_admin();
  perform t_report('A10 lock_admin drops the elevation', public.is_admin() is false,
                   'is_admin() returned ' || coalesce(public.is_admin()::text,'null'));
end $$;

set role authenticated;
select t_try($q$ update public.games set period = 7 where id = 'gN_byA' $q$) as code \gset
reset role;
do $$
declare p int;
begin
  select period into p from public.games where id = 'gN_byA';
  perform t_report('A11 ...and the locked session can no longer write', p = 6,
                   'period is now ' || coalesce(p::text,'null')
                     || ' - a filtered UPDATE reports no error, so the value is the evidence');
end $$;

-- Put the harness back the way the rest of the tree expects it.
update auth_state set uid = '11111111-1111-1111-1111-111111111111', anon = false;

-- report
select case when ok then '  PASS  ' else '  FAIL  ' end || label
       || coalesce(' :: ' || detail, '')
  from t_results order by n;
select '  ' || count(*) filter (where ok) || ' passed, '
       || count(*) filter (where not coalesce(ok, false)) || ' failed   [league_roles]'
  from t_results;
