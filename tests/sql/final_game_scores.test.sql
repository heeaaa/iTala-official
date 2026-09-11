-- @requires: is_admin, games_created_by, authz, rls, final_scores
--
-- public.final_game_scores - the server-side aggregation that answers "what did
-- this game end?" for readers outside the app.
--
-- WHY THESE CHECKS AND NOT OTHERS
--
-- The view is a SECOND implementation of a rule the app already owns: points
-- come from the event log, 2 / 3 / 1 for fg2_make / fg3_make / ft_make, summed
-- by exact team_id match (apply() and teamBoxScore() in src/lib/stats.ts). A
-- view that quietly disagrees is worse than no view at all, because the number
-- it publishes still looks like a score. So the aggregation checks below are the
-- ones where the two implementations could plausibly part company: the
-- non-scoring event types, a team that is not in this game, a final game with no
-- events, and the level score that must not become a home win.
--
-- The second half is about exposure. The view is created `with (security_invoker
-- = on)` precisely so it CANNOT publish rows the caller could not already read.
-- A view without that setting runs as its owner and bypasses row-level security
-- entirely, which is a data leak no aggregation test would ever notice.
--
-- Section order is load order: is_admin and games_created_by before authz, authz
-- before rls (the policies call it).

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

-- ---------------------------------------------------------------------------
-- Fixture: one league, three teams, five games in different end states.
-- ---------------------------------------------------------------------------
insert into public.leagues (id, name, season, kind, track_misses, track_turnovers,
                            is_shared, is_closed, is_archived, created_at)
values ('lg1', 'Papawis League', 'S1', 'league', true, true, false, false, false, 1);

insert into public.teams (id, league_id, name, color) values
  ('tH', 'lg1', 'Home Team', '#12D7D0'),
  ('tA', 'lg1', 'Away Team', '#C7F000'),
  ('tX', 'lg1', 'Some Other Team', '#FF0000');

insert into public.players (id, league_id, name, number) values
  ('pH1', 'lg1', 'Homer', '1'), ('pA1', 'lg1', 'Away Guy', '2');

insert into public.games (id, league_id, home_team_id, away_team_id, status,
                          scheduled_at, finished_at, period)
values ('gFinal',  'lg1', 'tH', 'tA', 'final',     1720000000000, 1720003600000, 4),
       ('gEmpty',  'lg1', 'tH', 'tA', 'final',     1720000000000, 1720007200000, 4),
       ('gTie',    'lg1', 'tH', 'tA', 'final',     1720000000000, 1720010800000, 4),
       ('gLive',   'lg1', 'tH', 'tA', 'live',      1720000000000, null,          2),
       ('gSched',  'lg1', 'tH', 'tA', 'scheduled', 1720000000000, null,          1);

-- gFinal: home 2 + 3 + 1 = 6, away 2 + 2 = 4, plus every non-scoring event type
-- the tracker can log, which must all contribute zero. `tX` is in the league but
-- not in this game; its basket belongs to neither side.
insert into public.events (id, league_id, game_id, team_id, player_id, type, period, ts) values
  ('e01','lg1','gFinal','tH','pH1','fg2_make',1,1),
  ('e02','lg1','gFinal','tH','pH1','fg3_make',1,2),
  ('e03','lg1','gFinal','tH','pH1','ft_make', 1,3),
  ('e04','lg1','gFinal','tH','pH1','fg2_miss',1,4),
  ('e05','lg1','gFinal','tH','pH1','fg3_miss',1,5),
  ('e06','lg1','gFinal','tH','pH1','ft_miss', 1,6),
  ('e07','lg1','gFinal','tH','pH1','reb',     2,7),
  ('e08','lg1','gFinal','tH','pH1','oreb',    2,8),
  ('e09','lg1','gFinal','tH','pH1','dreb',    2,9),
  ('e10','lg1','gFinal','tH','pH1','ast',     2,10),
  ('e11','lg1','gFinal','tH','pH1','stl',     3,11),
  ('e12','lg1','gFinal','tH','pH1','blk',     3,12),
  ('e13','lg1','gFinal','tH','pH1','tov',     3,13),
  ('e14','lg1','gFinal','tH','pH1','pf',      3,14),
  ('e15','lg1','gFinal','tH',null, 'timeout', 4,15),
  ('e16','lg1','gFinal','tA','pA1','fg2_make',1,16),
  ('e17','lg1','gFinal','tA',null, 'fg2_make',4,17),
  ('e18','lg1','gFinal','tX','pH1','fg3_make',4,18);

-- gTie: 2-2. A level score is not a home win.
insert into public.events (id, league_id, game_id, team_id, player_id, type, period, ts) values
  ('e20','lg1','gTie','tH','pH1','fg2_make',1,1),
  ('e21','lg1','gTie','tA','pA1','fg2_make',1,2);

-- gLive is being played right now and is not a final score yet.
insert into public.events (id, league_id, game_id, team_id, player_id, type, period, ts) values
  ('e30','lg1','gLive','tH','pH1','fg3_make',1,1);

-- ---------------------------------------------------------------------------
-- A. The aggregation
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  select * into r from public.final_game_scores where game_id = 'gFinal';
  perform t_report('A1 a final game appears in the view', r.game_id is not null,
                   'no row for a game whose status is final');
  perform t_report('A2 home points sum 2+3+1 and ignore every non-scoring tap',
                   r.home_pts = 6,
                   'home_pts = ' || coalesce(r.home_pts::text,'null') || ', expected 6 - a miss, '
                     || 'rebound, assist, steal, block, turnover, foul or timeout is scoring points');
  perform t_report('A3 away points include a team-level event (opponent-as-team)',
                   r.away_pts = 4,
                   'away_pts = ' || coalesce(r.away_pts::text,'null') || ', expected 4 - a player_id '
                     || 'of null is a team-level tap and still counts, exactly as teamBoxScore does');
  perform t_report('A4 an event stamped with a third team counts for neither side',
                   r.home_pts = 6 and r.away_pts = 4,
                   'a tX basket leaked into home=' || coalesce(r.home_pts::text,'null')
                     || ' away=' || coalesce(r.away_pts::text,'null'));
  perform t_report('A5 the winner is the higher score', r.winner_team_id = 'tH',
                   'winner_team_id = ' || coalesce(r.winner_team_id,'null'));
  perform t_report('A6 league and team names come along',
                   r.league_name = 'Papawis League' and r.season = 'S1'
                     and r.home_name = 'Home Team' and r.away_name = 'Away Team',
                   'names: ' || coalesce(r.home_name,'null') || ' vs ' || coalesce(r.away_name,'null')
                     || ' in ' || coalesce(r.league_name,'null'));
  perform t_report('A7 finished_at is carried through as epoch milliseconds',
                   r.finished_at = 1720003600000,
                   'finished_at = ' || coalesce(r.finished_at::text,'null'));
  perform t_report('A8 ...and converted to a real timestamp',
                   r.finished_at_ts = to_timestamp(1720003600000 / 1000.0),
                   'finished_at_ts = ' || coalesce(r.finished_at_ts::text,'null')
                     || ' - a seconds/milliseconds mix-up lands this in the year 56000');
end $$;

do $$
declare r record; n int;
begin
  select * into r from public.final_game_scores where game_id = 'gEmpty';
  perform t_report('A9 a final game with no events is 0-0, not missing',
                   r.game_id is not null and r.home_pts = 0 and r.away_pts = 0,
                   'got ' || coalesce(r.home_pts::text,'no row') || '-'
                     || coalesce(r.away_pts::text,'no row') || ' - an inner join to events would '
                     || 'drop this game entirely and the scheduler would never learn it finished');
  perform t_report('A10 ...and has no winner', r.winner_team_id is null,
                   'winner_team_id = ' || coalesce(r.winner_team_id,'null'));

  select * into r from public.final_game_scores where game_id = 'gTie';
  perform t_report('A11 a level score resolves to NO winner, never the home side',
                   r.home_pts = 2 and r.away_pts = 2 and r.winner_team_id is null,
                   'winner_team_id = ' || coalesce(r.winner_team_id,'null')
                     || ' - this is the F-11 `home >= away` bug, rewritten in SQL');

  select count(*) into n from public.final_game_scores where game_id in ('gLive','gSched');
  perform t_report('A12 live and scheduled games are not published as final scores', n = 0,
                   n || ' non-final game(s) in the view - a half-time score would be posted as a result');
end $$;

-- A13: games carries no foreign key to teams, so a deleted team must not take
-- the game's score out of the view with it.
delete from public.teams where id = 'tA';
do $$
declare r record;
begin
  select * into r from public.final_game_scores where game_id = 'gFinal';
  perform t_report('A13 a game whose team row is gone still reports its score',
                   r.game_id is not null and r.home_pts = 6 and r.away_pts = 4
                     and r.away_name is null,
                   'the row vanished or changed when the away team was deleted - an inner join to '
                     || 'teams hides finished games instead of reporting a null name');
end $$;
insert into public.teams (id, league_id, name, color) values ('tA','lg1','Away Team','#C7F000');

-- ---------------------------------------------------------------------------
-- B. Exposure. The view must not become a way around row-level security.
-- ---------------------------------------------------------------------------
-- Supabase grants these at the project level, so schema.sql does not. Without
-- them the checks below fail on a plain privilege error and never reach RLS.
grant usage on schema auth to authenticated;
grant select on auth_state to authenticated;
grant select on public.leagues, public.teams, public.players, public.games, public.events
  to authenticated;

-- A signed-in spectator: the read_all_* policies admit any session with a uid.
update auth_state set uid = '11111111-1111-1111-1111-111111111111', anon = false;
set role authenticated;
select count(*)::text as c from public.final_game_scores \gset signed_in_
reset role;
select t_report('B1 a signed-in session reads the final scores', :'signed_in_c' = '3',
                'got ' || :'signed_in_c' || ' rows, expected the 3 final games');

-- No session at all. Every read_all_* policy is `auth.uid() is not null`, so the
-- underlying rows are invisible - and so the view must be too.
update auth_state set uid = null, anon = false;
set role authenticated;
select count(*)::text as c from public.final_game_scores \gset anon_
reset role;
select t_report('B2 a session with no uid reads nothing through the view',
                :'anon_c' = '0',
                'got ' || :'anon_c' || ' rows - the view is bypassing row-level security, which '
                  || 'means security_invoker is off and it is running as its owner. Every private '
                  || 'league score is then readable by anyone holding the anon key');
update auth_state set uid = '11111111-1111-1111-1111-111111111111', anon = false;

do $$
declare v boolean;
begin
  select c.reloptions @> array['security_invoker=on'] into v
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'final_game_scores';
  perform t_report('B3 the view is declared security_invoker', coalesce(v, false),
                   'reloptions do not carry security_invoker=on - B2 can pass by accident on a '
                     || 'server where the caller simply lacks table privileges, so assert the '
                     || 'setting itself');
end $$;

do $$
declare has_anon boolean;
begin
  select has_table_privilege('anon', 'public.final_game_scores', 'select') into has_anon;
  perform t_report('B4 the view is not granted to anon', not has_anon,
                   'anon can select the view - an unauthenticated caller cannot read games or '
                     || 'events today, and this must not become the way around that');
end $$;

-- ---------------------------------------------------------------------------
-- C. Re-running schema.sql is the documented upgrade path (docs/DEPLOYMENT.md),
--    so every object here has to survive being loaded twice.
-- ---------------------------------------------------------------------------
do $$
declare code text;
begin
  begin
    execute 'create index if not exists games_final_finished_idx on public.games (finished_at) where status = ''final''';
    code := '00000';
  exception when others then code := sqlstate;
  end;
  perform t_report('C1 the partial index is idempotent', code = '00000',
                   're-running schema.sql failed with SQLSTATE ' || code);
end $$;

do $$
declare n int;
begin
  select count(*) into n from public.final_game_scores;
  perform t_report('C2 the view still reads correctly after a reload', n = 3,
                   'got ' || n || ' rows, expected 3');
end $$;

-- report
select case when ok then '  PASS  ' else '  FAIL  ' end || label
       || coalesce(' :: ' || detail, '')
  from t_results order by n;
select '  ' || count(*) filter (where ok) || ' passed, '
       || count(*) filter (where not coalesce(ok, false)) || ' failed   [final_game_scores]'
  from t_results;
