-- @requires: is_admin, games_created_by, authz, rec_setup
--
-- Section order matters and is load order: `authz` defines can_score_game, whose
-- body reads games.created_by, so `games_created_by` has to come first or the
-- function fails to create with "column g.created_by does not exist".
--
-- rec_setup_game on a COMMUNITY (shared) drop-in space that does not exist yet.
-- This is the cold path: a user taps "start a drop-in game" on a fresh project
-- and one RPC call has to create the league, both teams, every player and the
-- game itself, in one transaction, with created_by stamped server-side.
--
-- Until N-17 this file existed but never ran: it had no @requires marker, so the
-- runner skipped it and its checks were `select 'label', value` rows for a human
-- to read. The assertions below encode what those rows were being eyeballed for.

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

-- The call under test. Team Bravo's second player has an empty number, and
-- Pedro's is '09' - a leading zero that must survive as text, not become 9.
select public.rec_setup_game(
  'rec-shared','Community Drop-in Games (Papawis)', true, 1720000000000,
  'game_A','Southridge Gym', true, true,
  '[{"id":"tA","name":"Team Alpha","color":"#12D7D0","players":[
      {"id":"p1","name":"Juan Dela Cruz","number":"17"},
      {"id":"p2","name":"Pedro Santos","number":"09"}]},
    {"id":"tB","name":"Team Bravo","color":"#C7F000","players":[
      {"id":"p3","name":"Maria Reyes","number":"7"},
      {"id":"p4","name":"Jose Cruz","number":""}]}]'::jsonb);

do $$
declare r record;
begin
  select kind, season, is_shared, name into r from public.leagues where id = 'rec-shared';
  perform t_report('R1 league created as a shared recreational drop-in space',
                   r.kind = 'recreational' and r.season = 'Drop-In' and r.is_shared is true,
                   'got kind=' || coalesce(r.kind,'null') || ' season=' || coalesce(r.season,'null')
                     || ' is_shared=' || coalesce(r.is_shared::text,'null'));
end $$;

-- The shared community space belongs to nobody. If it gained an owner row, the
-- first person to start a game there would own everyone else's games.
do $$
declare c int;
begin
  select count(*) into c from public.league_members where league_id = 'rec-shared';
  perform t_report('R2 a SHARED space gets no owner membership row', c = 0,
                   'found ' || c || ' membership row(s)');
end $$;

do $$
declare c int; h text; a text;
begin
  select count(*) into c from public.teams where league_id = 'rec-shared';
  select home_team_id, away_team_id into h, a from public.games where id = 'game_A';
  perform t_report('R3 both teams written, home/away taken in array order',
                   c = 2 and h = 'tA' and a = 'tB',
                   'teams=' || c || ' home=' || coalesce(h,'null') || ' away=' || coalesce(a,'null'));
end $$;

do $$
declare c int;
begin
  select count(*) into c from public.players where league_id = 'rec-shared';
  perform t_report('R4 all four players written', c = 4, 'got ' || c);
end $$;

-- A jersey number is text precisely so '09' stays '09'.
do $$
declare v text;
begin
  select number into v from public.players where id = 'p2';
  perform t_report('R5 leading zero in a jersey number is preserved', v = '09',
                   'got ' || coalesce(quote_literal(v), 'null'));
end $$;

-- nullif(number,'') - an absent number must be null, not an empty string, so the
-- UI can distinguish "no number" from "number is blank".
do $$
-- `isnull` cannot be used as a variable name here: Postgres accepts `expr ISNULL`
-- as an operator, so a bare `isnull` in an expression is a syntax error.
declare v text; v_is_null boolean;
begin
  select number, number is null into v, v_is_null from public.players where id = 'p4';
  perform t_report('R6 an empty jersey number becomes null, not an empty string', v_is_null,
                   'got ' || coalesce(quote_literal(v), 'null'));
end $$;

do $$
declare r record;
begin
  select status, location, scheduled_at, created_by, period into r
    from public.games where id = 'game_A';
  perform t_report('R7 game created live, at the given location, in period 1',
                   r.status = 'live' and r.location = 'Southridge Gym'
                     and r.scheduled_at = 1720000000000 and r.period = 1,
                   'got status=' || coalesce(r.status,'null') || ' location='
                     || coalesce(r.location,'null') || ' period=' || coalesce(r.period::text,'null'));
end $$;

-- created_by is set from auth.uid() inside the function. The client never sends
-- it, and can_score_row depends on it being right.
do $$
declare v uuid;
begin
  select created_by into v from public.games where id = 'game_A';
  perform t_report('R8 created_by is stamped server-side from auth.uid()',
                   v = '11111111-1111-1111-1111-111111111111',
                   'got ' || coalesce(v::text, 'null'));
end $$;

-- teams.player_ids is what the app reads to render a roster; the players rows
-- alone are not enough.
do $$
declare v text[];
begin
  select player_ids into v from public.teams where id = 'tA';
  perform t_report('R9 team.player_ids wired to its players in order',
                   v = array['p1','p2'],
                   'got ' || coalesce(array_to_string(v, ','), 'null'));
end $$;

-- ---------------------------------------------------------------------------
-- The backup admin path.
--
-- elevate_to_admin raises whatever session the device already has, and on a
-- device with no Google/Apple account that session is ANONYMOUS. is_authed_user()
-- excludes anonymous sessions, so a Super Admin who unlocked with the password
-- was refused here while the rest of this schema granted them everything
-- (see the blanket is_admin() policies). The app agreed with the grant, so it
-- let them fill in two rosters and only then failed on save.
-- ---------------------------------------------------------------------------

-- An anonymous session that is NOT an admin must still be refused.
update auth_state set uid = '22222222-2222-2222-2222-222222222222', anon = true;
delete from public.profiles where id = '22222222-2222-2222-2222-222222222222';

do $$
declare msg text; wrote int;
begin
  begin
    perform public.rec_setup_game(
      'rec-anon','Private Drop-In Games', false, 1720000001000,
      'game_anon','Gym', true, true,
      '[{"id":"tX","name":"X","color":"#111111","players":[{"id":"px","name":"P","number":"1"}]},
        {"id":"tY","name":"Y","color":"#222222","players":[{"id":"py","name":"Q","number":"2"}]}]'::jsonb);
    msg := '(no error raised)';
  exception when others then msg := SQLERRM;
  end;
  perform t_report('R10 a plain anonymous session is still refused',
                   msg = 'Sign in to start a drop-in game.', 'got ' || quote_literal(msg));

  select count(*) into wrote from public.games where id = 'game_anon';
  perform t_report('R11 the refused call wrote nothing', wrote = 0, 'found ' || wrote || ' game(s)');
end $$;

-- Same anonymous session, now password-elevated to Super Admin.
insert into public.profiles (id, is_admin) values ('22222222-2222-2222-2222-222222222222', true)
on conflict (id) do update set is_admin = true;

do $$
declare msg text;
begin
  begin
    perform public.rec_setup_game(
      'rec-anon','Private Drop-In Games', false, 1720000001000,
      'game_anon','Gym', true, true,
      '[{"id":"tX","name":"X","color":"#111111","players":[{"id":"px","name":"P","number":"1"}]},
        {"id":"tY","name":"Y","color":"#222222","players":[{"id":"py","name":"Q","number":"2"}]}]'::jsonb);
    msg := null;
  exception when others then msg := SQLERRM;
  end;
  perform t_report('R12 a password-elevated Super Admin CAN start a drop-in game',
                   msg is null, 'raised ' || coalesce(quote_literal(msg), ''));
end $$;

do $$
declare r record;
begin
  select status, created_by into r from public.games where id = 'game_anon';
  perform t_report('R13 the game exists, stamped with the admin''s session uid',
                   r.status = 'live' and r.created_by = '22222222-2222-2222-2222-222222222222',
                   'got status=' || coalesce(r.status,'null') || ' created_by=' || coalesce(r.created_by::text,'null'));
end $$;

do $$
declare c int;
begin
  select count(*) into c from public.teams where league_id = 'rec-anon';
  perform t_report('R14 both teams landed with it', c = 2, 'found ' || c);
end $$;

-- Put the harness back the way the rest of the tree expects it.
update auth_state set uid = '11111111-1111-1111-1111-111111111111', anon = false;

-- report
select case when ok then '  PASS  ' else '  FAIL  ' end || label
       || coalesce(' :: ' || detail, '')
  from t_results order by n;
select '  ' || count(*) filter (where ok) || ' passed, '
       || count(*) filter (where not coalesce(ok, false)) || ' failed   [rec_setup]'
  from t_results;
