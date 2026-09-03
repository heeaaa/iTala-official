-- @requires: is_admin, games_created_by, authz, rls, games_creator, rec_setup, bulk_roster, add_player
--
-- THE THREE SECURITY DEFINER RPCs THAT UPSERT CALLER-SUPPLIED ROW IDs.
--
-- rec_setup_game, bulk_import_roster and add_player all follow the same shape:
-- authorise on the caller-supplied p_league_id, then
-- `insert ... on conflict (id) do update` on caller-supplied ROW ids. Two things
-- make that shape dangerous here rather than merely untidy:
--
--   * SECURITY DEFINER means RLS does not run inside the function, so the games
--     / teams / players policies never see these writes at all;
--   * can_score('rec-shared') is true for EVERY signed-in user, because the
--     community drop-in space is shared by design. So everybody holds a
--     p_league_id that passes the authorisation check.
--
-- Put together, the conflict branch was an unauthenticated-by-league write into
-- any row in the product. The row keeps its own league_id, so nothing about the
-- result looks like a cross-league write afterwards; you just find your team
-- renamed. Every id needed to do it is readable by any signed-in session through
-- the read_all_games / read_all_teams / read_all_players policies.
--
-- The second half of the file is the ID SQUAT, which is the same hole aimed at
-- the drop-in flow rather than at other leagues. Game ids are minted on the
-- device by uid() in src/lib/format.ts (a base36 clock plus a base36 random), so
-- they can be squatted ahead of use. An attacker inserts a game under the id the
-- victim is about to use, the shared space accepts it and stamps the attacker as
-- creator, and the victim's rec_setup_game then took the conflict branch and
-- RETURNED SUCCESSFULLY with created_by still pointing at the attacker - after
-- which every write the victim makes to their own game is refused 42501. That is
-- the exact broken-game symptom the created_by work just finished fixing, made
-- attacker-reachable.
--
-- The RPCs are invoked under `set role authenticated`, which is what the app
-- does and which also proves the grants. Fixture rows written as the table owner
-- bypass RLS and are labelled as fixtures.
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

create or replace function t_try(stmt text) returns text language plpgsql as $$
begin
  execute stmt;
  return '00000';
exception when others then
  return sqlstate;
end $$;

-- Returns the error message, or '(no error)'. The RPCs raise plpgsql exceptions
-- with a message the client shows the person, so the message is part of the
-- contract being tested, not just the fact of a refusal.
create or replace function t_err(stmt text) returns text language plpgsql as $$
begin
  execute stmt;
  return '(no error)';
exception when others then
  return SQLERRM;
end $$;

grant usage on schema auth to authenticated;
grant select on auth_state to authenticated;
grant select, insert, update, delete
  on public.leagues, public.teams, public.players, public.games, public.events
  to authenticated;

insert into auth.users (id) values
  ('dddddddd-0000-0000-0000-000000000004')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- The victim's world: a normal league nobody else belongs to.
-- Fixtures, owner-written.
-- ---------------------------------------------------------------------------
insert into public.leagues (id, name, season, kind, foul_out_limit, track_misses,
                            track_turnovers, is_shared, is_closed, is_archived, created_at)
values ('lgN','BPBL','S3','league',5,true,true,false,false,false,1720000000000);
insert into public.league_members (league_id, user_id, role)
values ('lgN','aaaaaaaa-0000-0000-0000-000000000001','owner');
insert into public.teams (id, league_id, name, color, player_ids) values
  ('tN1','lgN','Joyboys North','#12D7D0','{pN1}'),
  ('tN2','lgN','Philcan Grind','#C7F000','{pN2}');
insert into public.players (id, league_id, name, number) values
  ('pN1','lgN','Juan A','17'), ('pN2','lgN','Juan B','09');
insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at,
                          location, period, created_by)
values ('gLGE','lgN','tN1','tN2','live',1720000000000,'Southridge Gym',1,
        'aaaaaaaa-0000-0000-0000-000000000001');

-- The shared community space has to exist before a stranger can name it as
-- p_league_id. Created the way the app creates it.
update auth_state set uid = 'bbbbbbbb-0000-0000-0000-000000000002', anon = false;
set role authenticated;
select t_try($q$
  select public.rec_setup_game('rec-shared','Community Drop-in Games (Papawis)', true, 1720000000000,
    'gSEED','Gym', true, true,
    '[{"id":"cA","name":"Alpha","color":"#12D7D0","players":[{"id":"cp1","name":"A","number":"1"}]},
      {"id":"cB","name":"Bravo","color":"#C7F000","players":[{"id":"cp2","name":"B","number":"2"}]}]'::jsonb)
$q$) as code \gset
reset role;
select t_report('S0 the shared community space exists and any signed-in user can open a game in it',
                :'code' = '00000', 'rec_setup_game refused with SQLSTATE ' || :'code'
                  || ' - the rest of this file needs that permissiveness to be real');

do $$
begin
  perform t_report('S1 ...and can_score is true there for a user with no membership anywhere',
                   public.can_score('rec-shared') is true
                     and public.member_role('rec-shared') is null,
                   'can_score=' || coalesce(public.can_score('rec-shared')::text,'null')
                     || ' member_role=' || coalesce(public.member_role('rec-shared'),'(none)')
                     || ' - this is the valid p_league_id every attacker below holds');
end $$;

-- ===========================================================================
-- CROSS-LEAGUE: rec_setup_game naming a game row in someone else's league.
-- Reproduces C1/C2 from the review that found this.
-- ===========================================================================
update auth_state set uid = 'dddddddd-0000-0000-0000-000000000004', anon = false;
set role authenticated;
select t_err($q$
  select public.rec_setup_game('rec-shared','Community', true, 1720000000000,
    'gLGE','PWNED', true, true,
    '[{"id":"xA","name":"X","color":"#111","players":[{"id":"xp1","name":"X","number":"1"}]},
      {"id":"xB","name":"Y","color":"#222","players":[{"id":"xp2","name":"Y","number":"2"}]}]'::jsonb)
$q$) as msg \gset
reset role;
select t_report('C1 rec_setup_game refuses a game id that lives in another league',
                :'msg' like '%already exists in another league%',
                'expected a cross-league refusal, got ' || quote_literal(:'msg'));

do $$
declare r record;
begin
  select league_id, location, home_team_id, created_by, status into r
    from public.games where id = 'gLGE';
  perform t_report('C2 ...and the foreign game row is completely unchanged',
                   r.league_id = 'lgN' and r.location = 'Southridge Gym'
                     and r.home_team_id = 'tN1'
                     and r.created_by = 'aaaaaaaa-0000-0000-0000-000000000001',
                   'league=' || coalesce(r.league_id,'null')
                     || ' loc=' || coalesce(r.location,'null')
                     || ' home=' || coalesce(r.home_team_id,'null')
                     || ' created_by=' || coalesce(r.created_by::text,'null'));
end $$;

do $$
declare t int; p int;
begin
  select count(*) into t from public.teams   where id in ('xA','xB');
  select count(*) into p from public.players where id in ('xp1','xp2');
  perform t_report('C3 the refused call is atomic - no teams or players left behind',
                   t = 0 and p = 0, 'teams=' || t || ' players=' || p);
end $$;

-- ===========================================================================
-- CROSS-LEAGUE: bulk_import_roster reusing a foreign TEAM id. Reproduces J1.
-- ===========================================================================
set role authenticated;
select t_err($q$
  select public.bulk_import_roster('rec-shared',
    '[{"id":"tN1","name":"PWNED","color":"#000000","players":[{"id":"zz1","name":"Z","number":"1"}]}]'::jsonb)
$q$) as msg \gset
reset role;
select t_report('J1 bulk_import_roster refuses a team id that lives in another league',
                :'msg' like '%Team id tN1 already exists in another league%',
                'expected a cross-league refusal, got ' || quote_literal(:'msg'));

do $$
declare r record; n int;
begin
  select name, color, league_id, player_ids into r from public.teams where id = 'tN1';
  select count(*) into n from public.players where id = 'zz1';
  perform t_report('J2 ...and the foreign team keeps its name, colour, league and roster',
                   r.name = 'Joyboys North' and r.color = '#12D7D0'
                     and r.league_id = 'lgN' and r.player_ids = array['pN1'],
                   'name=' || coalesce(quote_literal(r.name),'null')
                     || ' color=' || coalesce(r.color,'null')
                     || ' league=' || coalesce(r.league_id,'null')
                     || ' player_ids=' || coalesce(r.player_ids::text,'null'));
  perform t_report('J3 ...and the refused import wrote none of its own rows either', n = 0,
                   'found ' || n || ' player(s) from the rolled-back call');
end $$;

-- CROSS-LEAGUE: bulk_import_roster reusing a foreign PLAYER id under a team id
-- of its own, so the team insert succeeds and only the player collides.
set role authenticated;
select t_err($q$
  select public.bulk_import_roster('rec-shared',
    '[{"id":"zt1","name":"Mine","color":"#000000","players":[{"id":"pN1","name":"PWNED","number":"99"}]}]'::jsonb)
$q$) as msg \gset
reset role;
select t_report('J4 bulk_import_roster refuses a player id that lives in another league',
                :'msg' like '%Player id pN1 already exists in another league%',
                'expected a cross-league refusal, got ' || quote_literal(:'msg'));

do $$
declare r record; n int;
begin
  select name, number, league_id into r from public.players where id = 'pN1';
  select count(*) into n from public.teams where id = 'zt1';
  perform t_report('J5 ...and the foreign player keeps its name, number and league',
                   r.name = 'Juan A' and r.number = '17' and r.league_id = 'lgN',
                   'name=' || coalesce(quote_literal(r.name),'null')
                     || ' number=' || coalesce(r.number,'null')
                     || ' league=' || coalesce(r.league_id,'null'));
  perform t_report('J6 ...and the team the same call did create was rolled back with it', n = 0,
                   'found ' || n || ' team(s) - the import must be all or nothing');
end $$;

-- CROSS-LEAGUE: add_player renaming a player in another league. Reproduces J2
-- from the review.
set role authenticated;
select t_err($q$
  select public.add_player('rec-shared','cA','pN2','PWNED','66')
$q$) as msg \gset
reset role;
select t_report('K1 add_player refuses a player id that lives in another league',
                :'msg' like '%Player id pN2 already exists in another league%',
                'expected a cross-league refusal, got ' || quote_literal(:'msg'));

do $$
declare r record; ids text[];
begin
  select name, number, league_id into r from public.players where id = 'pN2';
  select player_ids into ids from public.teams where id = 'cA';
  perform t_report('K2 ...and the foreign player is unchanged',
                   r.name = 'Juan B' and r.number = '09' and r.league_id = 'lgN',
                   'name=' || coalesce(quote_literal(r.name),'null')
                     || ' number=' || coalesce(r.number,'null')
                     || ' league=' || coalesce(r.league_id,'null'));
  perform t_report('K3 ...and the attacker''s own team was not wired to them either',
                   not (ids @> array['pN2']),
                   'cA.player_ids=' || coalesce(ids::text,'null'));
end $$;

-- CROSS-LEAGUE: rec_setup_game reusing a foreign TEAM id (the game id is fresh,
-- so this exercises the team guard inside the bundle rather than the pre-check).
set role authenticated;
select t_err($q$
  select public.rec_setup_game('rec-shared','Community', true, 1720000000000,
    'gFRESH1','Gym', true, true,
    '[{"id":"tN1","name":"PWNED","color":"#000","players":[]},
      {"id":"zB","name":"Y","color":"#222","players":[]}]'::jsonb)
$q$) as msg \gset
reset role;
select t_report('K4 rec_setup_game refuses a foreign team id inside the bundle',
                :'msg' like '%Team id tN1 already exists in another league%',
                'expected a cross-league refusal, got ' || quote_literal(:'msg'));

do $$
declare nm text; g int;
begin
  select name into nm from public.teams where id = 'tN1';
  select count(*) into g from public.games where id = 'gFRESH1';
  perform t_report('K5 ...leaving the foreign team and no half-built game',
                   nm = 'Joyboys North' and g = 0,
                   'tN1.name=' || coalesce(quote_literal(nm),'null') || ' games=' || g);
end $$;

-- CROSS-LEAGUE: rec_setup_game reusing a foreign PLAYER id.
set role authenticated;
select t_err($q$
  select public.rec_setup_game('rec-shared','Community', true, 1720000000000,
    'gFRESH2','Gym', true, true,
    '[{"id":"zC","name":"X","color":"#111","players":[{"id":"pN1","name":"PWNED","number":"99"}]},
      {"id":"zD","name":"Y","color":"#222","players":[]}]'::jsonb)
$q$) as msg \gset
reset role;
select t_report('K6 rec_setup_game refuses a foreign player id inside the bundle',
                :'msg' like '%Player id pN1 already exists in another league%',
                'expected a cross-league refusal, got ' || quote_literal(:'msg'));

do $$
declare nm text; t int;
begin
  select name into nm from public.players where id = 'pN1';
  select count(*) into t from public.teams where id in ('zC','zD');
  perform t_report('K7 ...leaving the foreign player and no half-built bundle',
                   nm = 'Juan A' and t = 0,
                   'pN1.name=' || coalesce(quote_literal(nm),'null') || ' teams=' || t);
end $$;

-- A Super Admin is not a licence to move rows between leagues. Nothing in the
-- product does this, and if a support tool ever needs to, it should say so
-- explicitly rather than inherit it from a drop-in RPC.
insert into public.profiles (id, is_admin) values ('cccccccc-0000-0000-0000-000000000003', true)
on conflict (id) do update set is_admin = true;
update auth_state set uid = 'cccccccc-0000-0000-0000-000000000003', anon = false;
set role authenticated;
select t_err($q$
  select public.rec_setup_game('rec-shared','Community', true, 1720000000000,
    'gLGE','ADMIN-MOVED', true, true,
    '[{"id":"aA","name":"X","color":"#111","players":[]},
      {"id":"aB","name":"Y","color":"#222","players":[]}]'::jsonb)
$q$) as msg \gset
reset role;
select t_report('K8 not even a Super Admin can move a game between leagues this way',
                :'msg' like '%already exists in another league%',
                'expected a cross-league refusal, got ' || quote_literal(:'msg'));

do $$
declare l text; loc text;
begin
  select league_id, location into l, loc from public.games where id = 'gLGE';
  perform t_report('K9 ...and the game is still where it was',
                   l = 'lgN' and loc = 'Southridge Gym',
                   'league=' || coalesce(l,'null') || ' loc=' || coalesce(loc,'null'));
end $$;

-- ===========================================================================
-- THE ID SQUAT.
--
-- ATTACKER = D. VICTIM = A. The victim is about to start a drop-in game under
-- the id 'gSQUAT'; the attacker gets there first.
-- ===========================================================================
update auth_state set uid = 'dddddddd-0000-0000-0000-000000000004', anon = false;
set role authenticated;
select t_try($q$
  insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at,
                            location, period)
    values ('gSQUAT','rec-shared','cA','cB','live',1719999999000,'squatted',1)
$q$) as code \gset
reset role;
select t_report('Q1 the squat itself is possible - the shared space accepts a new game from anyone',
                :'code' = '00000',
                'the insert was refused with SQLSTATE ' || :'code'
                  || ' - if this ever changes, Q2 is no longer testing what it claims');

do $$
declare c uuid;
begin
  select created_by into c from public.games where id = 'gSQUAT';
  perform t_report('Q2 ...and the trigger stamps the ATTACKER as its creator',
                   c = 'dddddddd-0000-0000-0000-000000000004',
                   'created_by=' || coalesce(c::text,'null'));
end $$;

-- The victim now runs the ordinary "start a drop-in game" flow on that id.
update auth_state set uid = 'aaaaaaaa-0000-0000-0000-000000000001', anon = false;
set role authenticated;
select t_err($q$
  select public.rec_setup_game('rec-shared','Community Drop-in Games (Papawis)', true, 1720000000000,
    'gSQUAT','Barangay Court', true, true,
    '[{"id":"vA","name":"Reds","color":"#FF4D4F","players":[{"id":"vp1","name":"Ana","number":"1"}]},
      {"id":"vB","name":"Blues","color":"#12D7D0","players":[{"id":"vp2","name":"Ben","number":"2"}]}]'::jsonb)
$q$) as msg \gset
reset role;
select t_report('Q3 the victim''s rec_setup_game is REFUSED, not silently diverted',
                :'msg' like '%was created by someone else%',
                'expected a clear ownership refusal, got ' || quote_literal(:'msg')
                  || ' - "(no error)" here is the bug: the call used to report success and '
                  || 'hand the victim a game every later write would fail 42501 on');

do $$
declare t int; p int; loc text; c uuid;
begin
  select count(*) into t from public.teams   where id in ('vA','vB');
  select count(*) into p from public.players where id in ('vp1','vp2');
  select location, created_by into loc, c from public.games where id = 'gSQUAT';
  perform t_report('Q4 ...and the victim is left with no half-created game',
                   t = 0 and p = 0,
                   'teams=' || t || ' players=' || p
                     || ' - the refusal must roll the whole bundle back');
  perform t_report('Q5 ...and the squatted row was not rewritten either',
                   loc = 'squatted' and c = 'dddddddd-0000-0000-0000-000000000004',
                   'loc=' || coalesce(loc,'null') || ' created_by=' || coalesce(c::text,'null'));
end $$;

-- The pre-fix failure mode, stated as an assertion so it cannot come back: the
-- victim must not end up owning-but-not-owning a game they cannot write.
update auth_state set uid = 'aaaaaaaa-0000-0000-0000-000000000001', anon = false;
set role authenticated;
select t_try($q$ update public.games set period = 2 where id = 'gSQUAT' $q$) as code \gset
reset role;
do $$
declare p int;
begin
  select period into p from public.games where id = 'gSQUAT';
  perform t_report('Q6 the victim still cannot write the squatted game - which is why Q3 must refuse',
                   p = 1,
                   'period is now ' || coalesce(p::text,'null')
                     || ' - the point of Q3 is that the victim is TOLD, rather than handed this row');
end $$;

-- Recovery: the person taps "start a drop-in game" again, the device mints a new
-- id, and it works. The refusal has to be recoverable, not terminal.
set role authenticated;
select t_err($q$
  select public.rec_setup_game('rec-shared','Community Drop-in Games (Papawis)', true, 1720000000000,
    'gRETRY','Barangay Court', true, true,
    '[{"id":"vA","name":"Reds","color":"#FF4D4F","players":[{"id":"vp1","name":"Ana","number":"1"}]},
      {"id":"vB","name":"Blues","color":"#12D7D0","players":[{"id":"vp2","name":"Ben","number":"2"}]}]'::jsonb)
$q$) as msg \gset
reset role;
select t_report('Q7 retrying under a fresh id succeeds', :'msg' = '(no error)',
                'the retry raised ' || quote_literal(:'msg'));

do $$
declare c uuid; t int; p int;
begin
  select created_by into c from public.games where id = 'gRETRY';
  select count(*) into t from public.teams   where id in ('vA','vB');
  select count(*) into p from public.players where id in ('vp1','vp2');
  perform t_report('Q8 ...and the retried game belongs to the victim, with its full bundle',
                   c = 'aaaaaaaa-0000-0000-0000-000000000001' and t = 2 and p = 2,
                   'created_by=' || coalesce(c::text,'null') || ' teams=' || t || ' players=' || p);
end $$;

-- Idempotent replay by the SAME creator must still be a no-op, not a refusal.
-- The client retries this call on a flaky network.
do $$
declare g0 int; t0 int; p0 int; g1 int; t1 int; p1 int; err text;
begin
  select count(*) into g0 from public.games;
  select count(*) into t0 from public.teams;
  select count(*) into p0 from public.players;
  err := t_err($q$
    select public.rec_setup_game('rec-shared','Community Drop-in Games (Papawis)', true, 1720000000000,
      'gRETRY','Barangay Court', true, true,
      '[{"id":"vA","name":"Reds","color":"#FF4D4F","players":[{"id":"vp1","name":"Ana","number":"1"}]},
        {"id":"vB","name":"Blues","color":"#12D7D0","players":[{"id":"vp2","name":"Ben","number":"2"}]}]'::jsonb)
  $q$);
  select count(*) into g1 from public.games;
  select count(*) into t1 from public.teams;
  select count(*) into p1 from public.players;
  perform t_report('Q9 the creator replaying their own identical call is still accepted',
                   err = '(no error)', 'replay raised ' || quote_literal(err)
                     || ' - the client retries this on a flaky network');
  perform t_report('Q10 ...and duplicates nothing',
                   g1 = g0 and t1 = t0 and p1 = p0,
                   'games ' || g0 || '->' || g1 || ', teams ' || t0 || '->' || t1
                     || ', players ' || p0 || '->' || p1);
end $$;

-- A stranger replaying the victim's now-legitimate bundle is refused on the
-- game, before it can rewrite the teams.
update auth_state set uid = 'dddddddd-0000-0000-0000-000000000004', anon = false;
set role authenticated;
select t_err($q$
  select public.rec_setup_game('rec-shared','Community Drop-in Games (Papawis)', true, 1720000000000,
    'gRETRY','TAKEN OVER', true, true,
    '[{"id":"vA","name":"PWNED","color":"#000","players":[]},
      {"id":"vB","name":"PWNED","color":"#000","players":[]}]'::jsonb)
$q$) as msg \gset
reset role;
select t_report('Q11 a stranger cannot re-run somebody else''s drop-in bundle',
                :'msg' like '%was created by someone else%',
                'expected an ownership refusal, got ' || quote_literal(:'msg'));

do $$
declare loc text; nm text;
begin
  select location into loc from public.games where id = 'gRETRY';
  select name into nm from public.teams where id = 'vA';
  perform t_report('Q12 ...and neither the game nor its teams were rewritten',
                   loc = 'Barangay Court' and nm = 'Reds',
                   'loc=' || coalesce(loc,'null') || ' vA.name=' || coalesce(quote_literal(nm),'null'));
end $$;

-- A LEGACY shared-space game (created_by null) is closed to everyone but an
-- admin by can_score_row, and rec_setup_game must agree rather than adopting it.
-- The session uid has to be null for this fixture: games_own_creator stamps
-- auth.uid() onto any INSERT that arrives without a creator, so writing it as an
-- ordinary session would quietly make the "legacy" row belong to the caller and
-- the check below would pass for the wrong reason. auth.uid() null is how a row
-- written before created_by existed is reproduced.
update auth_state set uid = null, anon = false;
insert into public.games (id, league_id, home_team_id, away_team_id, status, scheduled_at, created_by)
  values ('gLEGACY','rec-shared','cA','cB','live',1719000000000,null);   -- fixture, owner-written
do $$
declare c uuid;
begin
  select created_by into c from public.games where id = 'gLEGACY';
  perform t_report('Q13a the legacy fixture really is unowned', c is null,
                   'created_by=' || coalesce(c::text,'null') || ' - the fixture is wrong, not the code');
end $$;
update auth_state set uid = 'dddddddd-0000-0000-0000-000000000004', anon = false;
set role authenticated;
select t_err($q$
  select public.rec_setup_game('rec-shared','Community', true, 1720000000000,
    'gLEGACY','ADOPTED', true, true,
    '[{"id":"lA","name":"X","color":"#111","players":[]},
      {"id":"lB","name":"Y","color":"#222","players":[]}]'::jsonb)
$q$) as msg \gset
reset role;
select t_report('Q13 an unowned legacy shared-space game cannot be adopted through the RPC',
                :'msg' like '%was created by someone else%',
                'expected an ownership refusal, got ' || quote_literal(:'msg')
                  || ' - a null created_by must not fall open here either');

-- ===========================================================================
-- THE LEGITIMATE PATHS MUST ALL STILL WORK.
-- Same-league writes are exactly what these RPCs are for.
-- ===========================================================================
update auth_state set uid = 'aaaaaaaa-0000-0000-0000-000000000001', anon = false;
set role authenticated;
select t_err($q$
  select public.bulk_import_roster('lgN',
    '[{"id":"tN1","name":"Joyboys N","color":"#12D7D0","players":[
        {"id":"pN1","name":"Juan A. Cruz","number":"17"},
        {"id":"pN9","name":"New Signing","number":"4"}]}]'::jsonb)
$q$) as msg \gset
reset role;
select t_report('L1 the owner can still re-import their own league''s existing team',
                :'msg' = '(no error)', 'raised ' || quote_literal(:'msg'));

do $$
declare nm text; pn text; ids text[];
begin
  select name into nm from public.teams where id = 'tN1';
  select name into pn from public.players where id = 'pN1';
  select player_ids into ids from public.teams where id = 'tN1';
  perform t_report('L2 ...and the update really applied',
                   nm = 'Joyboys N' and pn = 'Juan A. Cruz' and ids = array['pN1','pN9'],
                   'team=' || coalesce(quote_literal(nm),'null')
                     || ' player=' || coalesce(quote_literal(pn),'null')
                     || ' player_ids=' || coalesce(ids::text,'null'));
end $$;

set role authenticated;
select t_err($q$ select public.add_player('lgN','tN2','pN2','Juan B. Reyes','09') $q$) as msg \gset
reset role;
select t_report('L3 add_player still works inside its own league', :'msg' = '(no error)',
                'raised ' || quote_literal(:'msg'));

do $$
declare nm text; ids text[];
begin
  select name into nm from public.players where id = 'pN2';
  select player_ids into ids from public.teams where id = 'tN2';
  perform t_report('L4 ...renaming the player and wiring them to the team',
                   nm = 'Juan B. Reyes' and ids @> array['pN2'],
                   'name=' || coalesce(quote_literal(nm),'null')
                     || ' tN2.player_ids=' || coalesce(ids::text,'null'));
end $$;

set role authenticated;
select t_err($q$ select public.add_player('lgN','tN1','pN10','Late Sub','23') $q$) as msg \gset
reset role;
do $$
declare nm text;
begin
  select name into nm from public.players where id = 'pN10';
  perform t_report('L5 add_player still creates a brand-new player', nm = 'Late Sub',
                   'got ' || coalesce(quote_literal(nm),'null'));
end $$;

-- Put the harness back the way the rest of the tree expects it.
update auth_state set uid = '11111111-1111-1111-1111-111111111111', anon = false;

-- report
select case when ok then '  PASS  ' else '  FAIL  ' end || label
       || coalesce(' :: ' || detail, '')
  from t_results order by n;
select '  ' || count(*) filter (where ok) || ' passed, '
       || count(*) filter (where not coalesce(ok, false)) || ' failed   [rpc_league_scoping]'
  from t_results;
