-- @requires: is_admin, games_created_by, authz, rec_setup, rls, games_creator
--
-- The community drop-in space, exercised through ROW-LEVEL SECURITY rather than
-- through the helper functions behind it.
--
-- community_creator_only.test.sql asks `can_score_game()` what it thinks. That
-- is necessary and it is not sufficient: it answered "yes, the creator may score
-- their own game" the entire time creators could not, in fact, save a lineup or
-- finish a game. The gap is the statement PostgREST actually sends.
--
-- `.upsert(row)` becomes:
--
--     insert into games (<payload columns>) values (...)
--     on conflict (id) do update set <payload columns>
--
-- and PostgreSQL applies the INSERT policy's WITH CHECK to the row PROPOSED for
-- insertion BEFORE it knows the conflict will divert that row to the UPDATE
-- path. `gameToRow` (src/sync/sync.ts) does not send created_by, so the proposed
-- row is unowned, `can_score_row` says no for a shared rec league, and the whole
-- statement is refused - while the stored row names the caller as its creator
-- and the update on its own would have been allowed. The scorekeeper sees a
-- starting five that reverts a second later and a game that will not finish.
--
-- So every check below runs `set role authenticated` first. The table owner
-- bypasses RLS; a suite that forgets this passes without testing anything.
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
-- refusal (insufficient_privilege) this file is about.
create or replace function t_try(stmt text) returns text language plpgsql as $$
begin
  execute stmt;
  return '00000';
exception when others then
  return sqlstate;
end $$;

-- Supabase grants these to `authenticated` at the project level, so schema.sql
-- does not. Without them every check below would fail on a plain privilege
-- error and never reach a policy.
grant usage on schema auth to authenticated;
grant select on auth_state to authenticated;
grant select, insert, update, delete
  on public.leagues, public.teams, public.players, public.games, public.events
  to authenticated;

-- ---------------------------------------------------------------------------
-- USER A, an ordinary signed-in user, creates a PUBLIC community drop-in game.
-- ---------------------------------------------------------------------------
update auth_state set uid = 'aaaaaaaa-0000-0000-0000-000000000001', anon = false;
select public.rec_setup_game('rec-shared','Community Drop-in Games (Papawis)', true, 1720000000000,
  'gCOM','Gym', true, true,
  '[{"id":"cA","name":"Alpha","color":"#12D7D0","players":[{"id":"cp1","name":"A","number":"1"}]},
    {"id":"cB","name":"Bravo","color":"#C7F000","players":[{"id":"cp2","name":"B","number":"2"}]}]'::jsonb);

do $$
declare v uuid;
begin
  select created_by into v from public.games where id = 'gCOM';
  perform t_report('D1 rec_setup_game stamps the creator',
                   v = 'aaaaaaaa-0000-0000-0000-000000000001',
                   'got ' || coalesce(v::text, 'null'));
end $$;

-- D2: the starting five. This is SET_LINEUPS reaching the server, column for
-- column as gameToRow builds it.
set role authenticated;
select t_try($q$
  insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at,
      location, finished_at, home_on_court, away_on_court, period, attendance,
      track_misses, track_turnovers)
    values ('gCOM','rec-shared','cA','cB','live',1720000000000,'Gym',null,
            '{cp1}','{cp2}',1,null,true,true)
    on conflict (id) do update set
      league_id = excluded.league_id, home_team_id = excluded.home_team_id,
      away_team_id = excluded.away_team_id, status = excluded.status,
      scheduled_at = excluded.scheduled_at, location = excluded.location,
      finished_at = excluded.finished_at, home_on_court = excluded.home_on_court,
      away_on_court = excluded.away_on_court, period = excluded.period,
      attendance = excluded.attendance, track_misses = excluded.track_misses,
      track_turnovers = excluded.track_turnovers
$q$) as code \gset
reset role;
select t_report('D2 the creator can save the starting lineup', :'code' = '00000',
                'the upsert PostgREST sends was refused with SQLSTATE ' || :'code');

do $$
declare h text[]; a text[];
begin
  select home_on_court, away_on_court into h, a from public.games where id = 'gCOM';
  perform t_report('D3 ...and the server row really holds it',
                   h = '{cp1}'::text[] and a = '{cp2}'::text[],
                   'server holds home=' || coalesce(h::text,'null') || ' away=' || coalesce(a::text,'null')
                     || ' - a pull would overwrite the lineup on the device');
end $$;

-- D4: the events path. can_score_game reads created_by off the STORED row, so
-- this was never broken - which is exactly why the game looked half-alive:
-- stats logged, lineup and status did not.
set role authenticated;
select t_try($q$
  insert into public.events (id, league_id, game_id, team_id, player_id, type, period, ts, note)
    values ('e1','rec-shared','gCOM','cA','cp1','3pm',1,1720000001000,null)
$q$) as code \gset
reset role;
select t_report('D4 the creator can log a stat', :'code' = '00000',
                'events insert refused with SQLSTATE ' || :'code');

-- D5: Finish. Same upsert, status and finished_at changed.
set role authenticated;
select t_try($q$
  insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at,
      location, finished_at, home_on_court, away_on_court, period, attendance,
      track_misses, track_turnovers)
    values ('gCOM','rec-shared','cA','cB','final',1720000000000,'Gym',1720000900000,
            '{cp1}','{cp2}',1,null,true,true)
    on conflict (id) do update set status = excluded.status,
      finished_at = excluded.finished_at, home_on_court = excluded.home_on_court,
      away_on_court = excluded.away_on_court
$q$) as code \gset
reset role;
select t_report('D5 the creator can finish the game', :'code' = '00000',
                'the finish upsert was refused with SQLSTATE ' || :'code');

do $$
declare s text; f bigint; c uuid;
begin
  select status, finished_at, created_by into s, f, c from public.games where id = 'gCOM';
  perform t_report('D6 ...and the server agrees the game is over',
                   s = 'final' and f is not null,
                   'server holds status=' || coalesce(s,'null') || ' finished_at=' || coalesce(f::text,'null')
                     || ' - Home would keep showing the Live card');
  perform t_report('D7 ...without the creator changing',
                   c = 'aaaaaaaa-0000-0000-0000-000000000001',
                   'created_by is now ' || coalesce(c::text,'null'));
end $$;

-- ---------------------------------------------------------------------------
-- USER B is a legitimate signed-in user with no claim on A's game.
-- ---------------------------------------------------------------------------
update auth_state set uid = 'bbbbbbbb-0000-0000-0000-000000000002', anon = false;

set role authenticated;
select t_try($q$
  insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at,
      home_on_court, away_on_court)
    values ('gCOM','rec-shared','cA','cB','live',1720000000000,'{cp2}','{cp1}')
    on conflict (id) do update set status = excluded.status,
      home_on_court = excluded.home_on_court, away_on_court = excluded.away_on_court
$q$) as code \gset
reset role;
select t_report('D8 a stranger CANNOT write to someone else''s community game', :'code' = '42501',
                'expected 42501, got ' || :'code');

set role authenticated;
select t_try($q$
  insert into public.games (id, league_id, home_team_id, away_team_id, status, created_by)
    values ('gCOM','rec-shared','cA','cB','live','bbbbbbbb-0000-0000-0000-000000000002')
    on conflict (id) do update set status = excluded.status, created_by = excluded.created_by
$q$) as code \gset
reset role;
select t_report('D9 a stranger cannot take the game over by sending created_by', :'code' = '42501',
                'expected 42501, got ' || :'code');

set role authenticated;
select t_try($q$
  insert into public.events (id, league_id, game_id, team_id, player_id, type, period, ts, note)
    values ('e2','rec-shared','gCOM','cA','cp1','3pm',1,1720000002000,null)
$q$) as code \gset
reset role;
select t_report('D10 a stranger cannot log a stat on it either', :'code' = '42501',
                'expected 42501, got ' || :'code');

do $$
declare c uuid; s text;
begin
  select created_by, status into c, s from public.games where id = 'gCOM';
  perform t_report('D11 the row survived all of that untouched',
                   c = 'aaaaaaaa-0000-0000-0000-000000000001' and s = 'final',
                   'created_by=' || coalesce(c::text,'null') || ' status=' || coalesce(s,'null'));
end $$;

-- The shared space is shared. B starting their OWN pickup game must still work,
-- and the server, not the client, decides whose it is.
set role authenticated;
select t_try($q$
  insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at,
      home_on_court, away_on_court, period)
    values ('gOWN','rec-shared','cA','cB','live',1720000100000,'{}','{}',1)
    on conflict (id) do update set status = excluded.status
$q$) as code \gset
reset role;
select t_report('D12 a stranger can still start their OWN community game', :'code' = '00000',
                'refused with SQLSTATE ' || :'code');

do $$
declare c uuid;
begin
  select created_by into c from public.games where id = 'gOWN';
  perform t_report('D13 ...and the server stamps it to them',
                   c = 'bbbbbbbb-0000-0000-0000-000000000002',
                   'got ' || coalesce(c::text,'null'));
end $$;

-- ---------------------------------------------------------------------------
-- An anonymous (guest) session. created_by is now stamped from auth.uid(), and
-- an anonymous session HAS a uid, so nothing but is_authed_user stands here.
-- ---------------------------------------------------------------------------
update auth_state set uid = 'bbbbbbbb-0000-0000-0000-000000000002', anon = true;
set role authenticated;
select t_try($q$
  insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at)
    values ('gANON','rec-shared','cA','cB','live',1720000200000)
    on conflict (id) do update set status = excluded.status
$q$) as code \gset
reset role;
select t_report('D14 an anonymous session cannot score in the shared space', :'code' = '42501',
                'expected 42501, got ' || :'code');
do $$
begin
  perform t_report('D15 ...and wrote nothing',
                   not exists (select 1 from public.games where id = 'gANON'),
                   'a guest session created a community game');
end $$;

-- ---------------------------------------------------------------------------
-- Super Admin. Allowed everywhere, and still not allowed to lose the creator.
-- ---------------------------------------------------------------------------
insert into public.profiles (id, is_admin) values ('cccccccc-0000-0000-0000-000000000003', true);
update auth_state set uid = 'cccccccc-0000-0000-0000-000000000003', anon = false;
set role authenticated;
select t_try($q$
  insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at, period)
    values ('gCOM','rec-shared','cA','cB','live',1720000000000,2)
    on conflict (id) do update set status = excluded.status, period = excluded.period
$q$) as code \gset
reset role;
select t_report('D16 a Super Admin can write to any community game', :'code' = '00000',
                'refused with SQLSTATE ' || :'code');

-- The regression a client-side "just send created_by" fix would have shipped:
-- an admin device whose local Game.createdBy is undefined sends null, PostgREST
-- puts created_by in the DO UPDATE SET list, and the real creator is locked out
-- of their own game for good. The trigger is what stops it.
set role authenticated;
select t_try($q$
  insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at, created_by)
    values ('gCOM','rec-shared','cA','cB','live',1720000000000,null)
    on conflict (id) do update set status = excluded.status, created_by = excluded.created_by
$q$) as code \gset
reset role;
do $$
declare c uuid;
begin
  select created_by into c from public.games where id = 'gCOM';
  perform t_report('D17 a write that sends created_by cannot rewrite the creator',
                   c = 'aaaaaaaa-0000-0000-0000-000000000001',
                   'created_by is now ' || coalesce(c::text,'null')
                     || ' - the real creator can no longer score their own game');
end $$;

-- ---------------------------------------------------------------------------
-- Rows written before created_by existed. auth.uid() null means the trigger has
-- nobody to stamp, which is how a legacy row is reproduced here.
-- ---------------------------------------------------------------------------
update auth_state set uid = null, anon = false;
insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at)
  values ('gLEGACY','rec-shared','cA','cB','final',1719000000000);
do $$
declare c uuid;
begin
  select created_by into c from public.games where id = 'gLEGACY';
  perform t_report('D18 a legacy shared-space row still has created_by null',
                   c is null, 'got ' || coalesce(c::text,'null') || ' - the fixture is wrong, not the code');
end $$;

update auth_state set uid = 'bbbbbbbb-0000-0000-0000-000000000002', anon = false;
set role authenticated;
select t_try($q$
  insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at)
    values ('gLEGACY','rec-shared','cA','cB','live',1719000000000)
    on conflict (id) do update set status = excluded.status
$q$) as code \gset
reset role;
select t_report('D19 a null created_by does not fall open in the shared space', :'code' = '42501',
                'expected 42501, got ' || :'code');

-- ---------------------------------------------------------------------------
-- Everywhere that is not the shared space, created_by is irrelevant and league
-- membership still decides. These are the rows a stricter rule would break.
-- ---------------------------------------------------------------------------
update auth_state set uid = null, anon = false;
insert into public.leagues values
  ('rec-a','Private Drop-In Games','Drop-In','recreational',null,true,true,false,false,false,1720000000000);
insert into public.league_members values ('rec-a','aaaaaaaa-0000-0000-0000-000000000001','owner');
insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at)
  values ('gPRIV','rec-a','cA','cB','live',1720000000000);
insert into public.leagues values
  ('lgN','BPBL','S3','league',null,true,true,false,false,false,1720000000000);
insert into public.league_members values ('lgN','aaaaaaaa-0000-0000-0000-000000000001','scorekeeper');
insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at)
  values ('gLGE','lgN','cA','cB','live',1720000000000);

update auth_state set uid = 'aaaaaaaa-0000-0000-0000-000000000001', anon = false;
set role authenticated;
select t_try($q$
  insert into public.games (id, league_id, home_team_id, away_team_id, status, home_on_court)
    values ('gPRIV','rec-a','cA','cB','live','{cp1}')
    on conflict (id) do update set home_on_court = excluded.home_on_court
$q$) as code \gset
reset role;
select t_report('D20 a PRIVATE rec owner can still save a lineup (created_by null)',
                :'code' = '00000', 'refused with SQLSTATE ' || :'code');

update auth_state set uid = 'aaaaaaaa-0000-0000-0000-000000000001', anon = false;
set role authenticated;
select t_try($q$
  insert into public.games (id, league_id, home_team_id, away_team_id, status, home_on_court)
    values ('gLGE','lgN','cA','cB','live','{cp1}')
    on conflict (id) do update set home_on_court = excluded.home_on_court
$q$) as code \gset
reset role;
select t_report('D21 a normal-league scorekeeper can still save a lineup (created_by null)',
                :'code' = '00000', 'refused with SQLSTATE ' || :'code');

update auth_state set uid = '11111111-1111-1111-1111-111111111111', anon = false;

-- ---------------------------------------------------------------------------
-- A GUEST SESSION THAT NAMES ITSELF AS THE CREATOR.
--
-- D14 is not evidence about this, and it is worth being precise about why: it
-- sends no created_by, so the row proposed for insertion is unowned and
-- `p_created_by is not null` refuses it on its own. D14 is green whether or not
-- can_score_row consults is_authed_user() - it was green before that call was
-- added. The combination the new call actually defends is an ANONYMOUS uid that
-- MATCHES the row's created_by, and there are two ways to reach it:
--
--   * the payload is caller-controlled. PostgREST forwards every column in the
--     JSON body, the anon key ships inside the app binary, and games carries a
--     `for all` policy - so a request that is not gameToRow can put the caller's
--     own uid in created_by and satisfy `p_created_by = auth.uid()`.
--   * a row that already carries that uid: written while the session was not
--     anonymous, or written at all before this rule existed.
--
-- Until can_score_row required is_authed_user(), both of those were a guest
-- session with full scoring rights over a game in the shared community space.
-- ---------------------------------------------------------------------------
insert into auth.users (id) values ('dddddddd-0000-0000-0000-000000000004')
  on conflict (id) do nothing;
update auth_state set uid = 'dddddddd-0000-0000-0000-000000000004', anon = true;

set role authenticated;
select t_try($q$
  insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at, created_by)
    values ('gGUEST','rec-shared','cA','cB','live',1720000300000,'dddddddd-0000-0000-0000-000000000004')
    on conflict (id) do update set status = excluded.status, created_by = excluded.created_by
$q$) as code \gset
reset role;
select t_report('D22 a guest cannot claim a NEW community game by naming itself creator',
                :'code' = '42501', 'expected 42501, got ' || :'code'
                  || ' - an anonymous session now owns a scoreable game in the shared space');

-- A row that already names the guest. Inserted as the table owner on purpose:
-- RLS is bypassed, so this is a fixture, not an assertion. It stands for a row
-- written before this rule existed.
insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at, created_by)
  values ('gGUESTOLD','rec-shared','cA','cB','live',1720000400000,'dddddddd-0000-0000-0000-000000000004');

set role authenticated;
select t_try($q$
  insert into public.games (id, league_id, home_team_id, away_team_id, status, home_on_court, created_by)
    values ('gGUESTOLD','rec-shared','cA','cB','live','{cp1}','dddddddd-0000-0000-0000-000000000004')
    on conflict (id) do update set status = excluded.status,
      home_on_court = excluded.home_on_court, created_by = excluded.created_by
$q$) as code \gset
reset role;
select t_report('D23 ...nor score a STORED row that already names it', :'code' = '42501',
                'expected 42501, got ' || :'code'
                  || ' - the games policy let a guest through on the stored row');

set role authenticated;
select t_try($q$
  insert into public.events (id, league_id, game_id, team_id, player_id, type, period, ts, note)
    values ('eGUEST','rec-shared','gGUESTOLD','cA','cp1','3pm',1,1720000401000,null)
$q$) as code \gset
reset role;
select t_report('D24 ...nor log a stat on it', :'code' = '42501',
                'expected 42501, got ' || :'code'
                  || ' - can_score_game let a guest through');

-- ---------------------------------------------------------------------------
-- DELETING THE ACCOUNT MUST STILL CLEAR THE ROW'S CREATOR.
--
-- games.created_by carries `references auth.users(id) on delete set null`, and
-- PostgreSQL performs that cascade as an UPDATE - so it passes straight through
-- games_own_creator. The trigger's `new.created_by is not null` guard is the
-- only reason deletion still works: the obvious simplification,
-- `new.created_by := coalesce(new.created_by, old.created_by)`, puts the deleted
-- uid back, the referential-integrity check skips a key it sees as unchanged,
-- and the row is left naming an account that no longer exists - in a table whose
-- write policy is built on that column.
--
-- This is a GUARD, not a regression test. It passes against the pre-fix schema
-- as well, because there was no trigger there to defeat the cascade. It exists
-- so that the next edit to the trigger cannot quietly take account deletion with
-- it, and so that `on delete set null` cannot quietly become `on delete
-- cascade` and start deleting other people's game history.
-- ---------------------------------------------------------------------------
insert into auth.users (id) values ('eeeeeeee-0000-0000-0000-000000000005')
  on conflict (id) do nothing;
-- Written as the table owner: RLS is bypassed, so this is a fixture and not an
-- assertion. What is under test here is the FK cascade meeting the trigger, not
-- the policy - D12/D13 already cover a signed-in user starting their own game,
-- and keeping this fixture off the policy path is what lets D25/D26 stay
-- meaningful against a schema where the policy itself is broken.
insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at, created_by)
  values ('gDEL','rec-shared','cA','cB','live',1720000500000,'eeeeeeee-0000-0000-0000-000000000005');

delete from auth.users where id = 'eeeeeeee-0000-0000-0000-000000000005';

do $$
declare c uuid; n int;
begin
  select count(*) into n from public.games where id = 'gDEL';
  perform t_report('D25 deleting the account keeps the game', n = 1,
                   'the game row went with the account - on delete set null has become a cascade, '
                     || 'so removing one account now erases games other people played in');
  select created_by into c from public.games where id = 'gDEL';
  perform t_report('D26 ...and clears its creator',
                   n = 1 and c is null,
                   'created_by is still ' || coalesce(c::text,'null')
                     || ' - the row names an auth account that no longer exists, because the trigger '
                     || 'put back a value the FK cascade had just cleared');
end $$;

-- report
select case when ok then '  PASS  ' else '  FAIL  ' end || label
       || coalesce(' :: ' || detail, '')
  from t_results order by n;
select '  ' || count(*) filter (where ok) || ' passed, '
       || count(*) filter (where not coalesce(ok, false)) || ' failed   [community_game_writes]'
  from t_results;
