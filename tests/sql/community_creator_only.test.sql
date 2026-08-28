-- @requires: is_admin, games_created_by, authz, rec_setup
--
-- Who may score a game. This is the highest-consequence authorisation rule in
-- the schema, and until N-17 it had no automated coverage at all.
--
-- The community drop-in space is ONE shared league holding everybody's pickup
-- games. So league-level rights are the wrong granularity there: `can_score`
-- returns true for any signed-in user on a shared rec league, which would let a
-- stranger edit your game's score. `can_score_row` narrows it to the creator,
-- and `can_score_game` is what the games RLS policy actually calls.
--
-- The interesting cases are the ones where the two rules disagree - C3 vs C4
-- below - and the legacy rows where created_by is null and must NOT fall open.
--
-- Section order is load order: `authz` defines can_score_game, whose body reads
-- games.created_by, so `games_created_by` must load first.

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

-- USER A creates a community drop-in game.
update auth_state set uid = 'aaaaaaaa-0000-0000-0000-000000000001', anon = false;
select public.rec_setup_game('rec-shared','Community Drop-in Games (Papawis)', true, 1720000000000,
  'gCOM','Gym', true, true,
  '[{"id":"cA","name":"Alpha","color":"#12D7D0","players":[{"id":"cp1","name":"A","number":"1"}]},
    {"id":"cB","name":"Bravo","color":"#C7F000","players":[{"id":"cp2","name":"B","number":"2"}]}]'::jsonb);

do $$
declare v uuid;
begin
  select created_by into v from public.games where id = 'gCOM';
  perform t_report('C1 the creator is stamped on the game',
                   v = 'aaaaaaaa-0000-0000-0000-000000000001',
                   'got ' || coalesce(v::text, 'null'));
end $$;

do $$
begin
  perform t_report('C2 the creator can score their own community game',
                   public.can_score_game('gCOM'), 'can_score_game returned false');
end $$;

-- The whole point of can_score_row. B is a legitimate signed-in user with every
-- right to start their OWN game in the shared space, and no right to touch A's.
update auth_state set uid = 'bbbbbbbb-0000-0000-0000-000000000002', anon = false;
do $$
begin
  perform t_report('C3 another signed-in user CANNOT score someone else''s community game',
                   public.can_score_game('gCOM') is false,
                   'can_score_game returned ' || coalesce(public.can_score_game('gCOM')::text, 'null'));
end $$;

-- Deliberately asserting the league-level rule is still permissive here. This is
-- not a bug: it is why the per-game rule had to exist. If this ever flips to
-- false, can_score_game is no longer the thing protecting the shared space and
-- C3 may be passing for the wrong reason.
do $$
begin
  perform t_report('C4 ...while the league-level rule alone would have allowed it',
                   public.can_score('rec-shared') is true,
                   'can_score(rec-shared) returned '
                     || coalesce(public.can_score('rec-shared')::text, 'null')
                     || ' - if this is false, C3 is no longer proving what it claims');
end $$;

-- Super Admin overrides everything.
insert into public.profiles (id, is_admin) values ('cccccccc-0000-0000-0000-000000000003', true);
update auth_state set uid = 'cccccccc-0000-0000-0000-000000000003', anon = false;
do $$
begin
  perform t_report('C5 a Super Admin can score any community game',
                   public.can_score_game('gCOM'), 'can_score_game returned false');
end $$;

-- Rows written before created_by existed have it null. `can_score_row` must treat
-- null as "nobody owns this", not as "anybody may".
insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at, created_by)
  values ('gLEGACY','rec-shared','cA','cB','final',1719000000000,null);
do $$
begin
  perform t_report('C6 an admin can still score a legacy community game (created_by null)',
                   public.can_score_game('gLEGACY'), 'can_score_game returned false');
end $$;

update auth_state set uid = 'bbbbbbbb-0000-0000-0000-000000000002', anon = false;
do $$
begin
  perform t_report('C7 a non-admin CANNOT score a legacy community game (created_by null)',
                   public.can_score_game('gLEGACY') is false,
                   'a null created_by must not fall open; got '
                     || coalesce(public.can_score_game('gLEGACY')::text, 'null'));
end $$;

-- Everywhere that is NOT a shared rec league, the league rules still apply and a
-- null created_by is irrelevant. These two guard against "fixing" the shared-space
-- rule by making created_by mandatory everywhere, which would lock owners and
-- scorekeepers out of their own leagues.
update auth_state set uid = 'aaaaaaaa-0000-0000-0000-000000000001', anon = false;
insert into public.leagues values
  ('rec-a','Private Drop-In Games','Drop-In','recreational',null,true,true,false,false,false,1720000000000);
insert into public.league_members values ('rec-a','aaaaaaaa-0000-0000-0000-000000000001','owner');
insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at, created_by)
  values ('gPRIV','rec-a','x','y','live',1720000000000,null);
do $$
begin
  perform t_report('C8 a PRIVATE rec owner can score their game despite created_by being null',
                   public.can_score_game('gPRIV'),
                   'the creator-only rule must apply to shared rec spaces only');
end $$;

insert into public.leagues values
  ('lgN','BPBL','S3','league',null,true,true,false,false,false,1720000000000);
insert into public.league_members values ('lgN','aaaaaaaa-0000-0000-0000-000000000001','scorekeeper');
insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at, created_by)
  values ('gLGE','lgN','x','y','live',1720000000000,null);
do $$
begin
  perform t_report('C9 a normal-league scorekeeper can score despite created_by being null',
                   public.can_score_game('gLGE'),
                   'ordinary league rights must be unaffected by the shared-space rule');
end $$;

-- An anonymous (guest) session must never score, even in the shared space where
-- the league-level rule is otherwise permissive.
update auth_state set uid = 'bbbbbbbb-0000-0000-0000-000000000002', anon = true;
do $$
begin
  perform t_report('C10 an anonymous session cannot score in the shared space',
                   public.can_score('rec-shared') is false,
                   'is_authed_user must exclude anonymous sessions; got '
                     || coalesce(public.can_score('rec-shared')::text, 'null'));
end $$;
update auth_state set uid = '11111111-1111-1111-1111-111111111111', anon = false;

-- report
select case when ok then '  PASS  ' else '  FAIL  ' end || label
       || coalesce(' :: ' || detail, '')
  from t_results order by n;
select '  ' || count(*) filter (where ok) || ' passed, '
       || count(*) filter (where not coalesce(ok, false)) || ' failed   [community_creator_only]'
  from t_results;
