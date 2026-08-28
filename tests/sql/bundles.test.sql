-- @requires: is_admin, games_created_by, authz, rec_setup, bulk_roster
--
-- The remaining rec_setup_game paths, plus bulk_import_roster:
--   * a PRIVATE space is owned by its creator, a SHARED one by nobody
--   * replaying the same call is a no-op, because the client retries on a flaky
--     network and every write in here is an upsert
--   * missing name/colour must not abort an import - teams.color is NOT NULL, so
--     a roster pasted without colours would otherwise fail at the database
--   * bulk_import_roster preserves jersey numbers as text
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

-- A shared space to contrast against, then a private one.
select public.rec_setup_game('rec-shared','Community Drop-in Games (Papawis)', true, 1720000000000,
  'game_A','Southridge Gym', true, true,
  '[{"id":"tA","name":"Team Alpha","color":"#12D7D0","players":[
      {"id":"p1","name":"Juan Dela Cruz","number":"17"},
      {"id":"p2","name":"Pedro Santos","number":"09"}]},
    {"id":"tB","name":"Team Bravo","color":"#C7F000","players":[
      {"id":"p3","name":"Maria Reyes","number":"7"},
      {"id":"p4","name":"Jose Cruz","number":""}]}]'::jsonb);

select public.rec_setup_game('rec-mine','Private Drop-In Games', false, 1720000001000,
  'game_B','Barangay Court', true, false,
  '[{"id":"tC","name":"Reds","color":"#FF4D4F","players":[{"id":"p5","name":"Ana","number":"1"}]},
    {"id":"tD","name":"Blues","color":"#12D7D0","players":[{"id":"p6","name":"Ben","number":"2"}]}]'::jsonb);

do $$
declare c int;
begin
  select count(*) into c from public.league_members where league_id = 'rec-mine' and role = 'owner';
  perform t_report('D1 a PRIVATE drop-in space is owned by its creator', c = 1, 'found ' || c);
end $$;

do $$
declare c int;
begin
  select count(*) into c from public.league_members where league_id = 'rec-shared';
  perform t_report('D2 a SHARED drop-in space is owned by nobody', c = 0,
                   'found ' || c || ' membership row(s) - the first user would own everyone''s games');
end $$;

-- Idempotency: replay the identical shared-space call. The client retries when a
-- push fails, so a second identical call must not duplicate anything.
do $$
declare g0 int; t0 int; p0 int; g1 int; t1 int; p1 int;
begin
  select count(*) into g0 from public.games;
  select count(*) into t0 from public.teams;
  select count(*) into p0 from public.players;

  perform public.rec_setup_game('rec-shared','Community Drop-in Games (Papawis)', true, 1720000000000,
    'game_A','Southridge Gym', true, true,
    '[{"id":"tA","name":"Team Alpha","color":"#12D7D0","players":[
        {"id":"p1","name":"Juan Dela Cruz","number":"17"},
        {"id":"p2","name":"Pedro Santos","number":"09"}]},
      {"id":"tB","name":"Team Bravo","color":"#C7F000","players":[
        {"id":"p3","name":"Maria Reyes","number":"7"},
        {"id":"p4","name":"Jose Cruz","number":""}]}]'::jsonb);

  select count(*) into g1 from public.games;
  select count(*) into t1 from public.teams;
  select count(*) into p1 from public.players;

  perform t_report('D3 replaying the identical call duplicates nothing',
                   g1 = g0 and t1 = t0 and p1 = p0,
                   'games ' || g0 || '->' || g1 || ', teams ' || t0 || '->' || t1
                     || ', players ' || p0 || '->' || p1);
end $$;

-- The NOT NULL trap. teams.color is NOT NULL and players.name is NOT NULL, so a
-- roster pasted with a blank team name, no colour key at all, and a blank player
-- name has to be defaulted rather than rejected.
select public.rec_setup_game('rec-shared','Community', true, 1720000002000,
  'game_C','', null, null,
  '[{"id":"tE","name":"","players":[{"id":"p7","name":"","number":"5"}]},
    {"id":"tF","name":"Yellows","players":[{"id":"p8","name":"Cara","number":"6"}]}]'::jsonb);

do $$
declare r record;
begin
  select name, color into r from public.teams where id = 'tE';
  perform t_report('D4 a blank team name and absent colour fall back to defaults',
                   r.name = 'Team' and r.color = '#12D7D0',
                   'got name=' || coalesce(quote_literal(r.name),'null')
                     || ' color=' || coalesce(quote_literal(r.color),'null'));
end $$;

do $$
declare v text;
begin
  select name into v from public.players where id = 'p7';
  perform t_report('D5 a blank player name falls back to ''Player''', v = 'Player',
                   'got ' || coalesce(quote_literal(v), 'null'));
end $$;

do $$
declare v text; v_is_null boolean;
begin
  select location, location is null into v, v_is_null from public.games where id = 'game_C';
  perform t_report('D6 an empty location becomes null, not an empty string', v_is_null,
                   'got ' || coalesce(quote_literal(v), 'null'));
end $$;

-- bulk_import_roster: the paste-a-roster path into a normal league.
insert into public.leagues values
  ('lg1','BPBL','S3','league',null,true,true,false,false,false,1720000003000);
insert into public.league_members values ('lg1','11111111-1111-1111-1111-111111111111','owner');
select public.bulk_import_roster('lg1',
  '[{"id":"bt1","name":"Joyboys North","color":"#12D7D0","players":[
      {"id":"bp1","name":"Juan A","number":"17"},{"id":"bp2","name":"Juan B","number":"420"}]},
    {"id":"bt2","name":"Philcan grind","color":"#C7F000","players":[
      {"id":"bp3","name":"Juan C","number":"09"},{"id":"bp4","name":"Juan D","number":""}]}]'::jsonb);

do $$
declare t int; p int;
begin
  select count(*) into t from public.teams where league_id = 'lg1';
  select count(*) into p from public.players where league_id = 'lg1';
  perform t_report('D7 bulk import writes both teams and all four players',
                   t = 2 and p = 4, 'teams=' || t || ' players=' || p);
end $$;

do $$
declare v text[];
begin
  select player_ids into v from public.teams where id = 'bt1';
  perform t_report('D8 bulk import wires team.player_ids', v = array['bp1','bp2'],
                   'got ' || coalesce(array_to_string(v, ','), 'null'));
end $$;

-- Jersey numbers are text on purpose: '09' must not become 9, and '420' is a
-- perfectly ordinary thing for a pickup roster to contain.
do $$
declare a text; b text; c_is_null boolean;
begin
  select number into a from public.players where id = 'bp3';
  select number into b from public.players where id = 'bp2';
  select number is null into c_is_null from public.players where id = 'bp4';
  perform t_report('D9 jersey numbers survive as text, and blank becomes null',
                   a = '09' and b = '420' and c_is_null,
                   'bp3=' || coalesce(quote_literal(a),'null')
                     || ' bp2=' || coalesce(quote_literal(b),'null')
                     || ' bp4_is_null=' || coalesce(c_is_null::text,'null'));
end $$;

-- Authorisation on the import path itself: a user with no rights in a normal
-- league must be refused.
update auth_state set uid = '22222222-2222-2222-2222-222222222222', anon = false;
do $$
declare raised boolean := false; err text;
begin
  begin
    perform public.bulk_import_roster('lg1',
      '[{"id":"bz1","name":"Intruders","color":"#000","players":[]}]'::jsonb);
  exception when others then
    raised := true; err := SQLERRM;
  end;
  perform t_report('D10 a non-member cannot bulk import into a league',
                   raised and err like '%Scorekeeper access required%',
                   'expected a scorekeeper refusal, got ' || coalesce(quote_literal(err),'no error'));
end $$;

do $$
declare c int;
begin
  select count(*) into c from public.teams where id = 'bz1';
  perform t_report('D11 the refused import wrote nothing', c = 0, 'found ' || c);
end $$;

-- N-18. players.name is NOT NULL and a pasted roster can legitimately contain a
-- row with a blank or absent name. bulk_import_roster used to insert
-- `ply->>'name'` raw, so ONE such row aborted the whole import and took every
-- other team and player in the call with it - while rec_setup_game, doing the
-- same job on the drop-in path, defaulted it to 'Player'. Now both do.
update auth_state set uid = '11111111-1111-1111-1111-111111111111', anon = false;
do $$
declare raised boolean := false; err text;
begin
  begin
    perform public.bulk_import_roster('lg1',
      '[{"id":"bt9","name":"Nameless key","color":"#123456","players":[
          {"id":"bp9","number":"3"},
          {"id":"bp10","name":"","number":"4"},
          {"id":"bp11","name":"Real Person","number":"5"}]}]'::jsonb);
  exception when others then
    raised := true; err := SQLERRM;
  end;
  perform t_report('D12 a player with no name key no longer aborts the import',
                   not raised,
                   'import raised: ' || coalesce(quote_literal(err), '(none)'));
end $$;

do $$
declare a text; b text;
begin
  select name into a from public.players where id = 'bp9';   -- no "name" key at all
  select name into b from public.players where id = 'bp10';  -- present but empty
  perform t_report('D13 both an absent and a blank name fall back to ''Player''',
                   a = 'Player' and b = 'Player',
                   'bp9=' || coalesce(quote_literal(a),'null')
                     || ' bp10=' || coalesce(quote_literal(b),'null'));
end $$;

-- The point of the fix: the rest of the payload has to survive. Before, the
-- nameless row took the whole call down.
do $$
declare c int; nm text;
begin
  select count(*) into c from public.players where league_id = 'lg1' and id like 'bp%';
  select name into nm from public.players where id = 'bp11';
  perform t_report('D14 the other players in the same call are still imported',
                   c = 7 and nm = 'Real Person',
                   'players=' || c || ' (expected 7) bp11=' || coalesce(quote_literal(nm),'null'));
end $$;

-- And the fallback must not overwrite a name that was actually given.
do $$
declare v text;
begin
  select name into v from public.players where id = 'bp1';
  perform t_report('D15 a supplied name is never replaced by the fallback',
                   v = 'Juan A', 'got ' || coalesce(quote_literal(v), 'null'));
end $$;

-- report
select case when ok then '  PASS  ' else '  FAIL  ' end || label
       || coalesce(' :: ' || detail, '')
  from t_results order by n;
select '  ' || count(*) filter (where ok) || ' passed, '
       || count(*) filter (where not coalesce(ok, false)) || ' failed   [bundles]'
  from t_results;
