-- @requires: is_admin, games_created_by, authz, rec_setup, rec_receipts
create table t_results(ok boolean, label text);
create function reject_test_game() returns trigger language plpgsql as $$
begin if new.id='atomic-game' then raise exception 'test rejection after team inserts'; end if; return new; end $$;
create trigger reject_test_game before insert on games for each row execute function reject_test_game();
do $$
declare
  actor uuid := '11111111-1111-1111-1111-111111111111';
  setup jsonb := '{"league_id":"rec-test","league_name":"Community","shared":true,"created_at":1000,"game_id":"rec-game","location":"Court","track_misses":true,"track_turnovers":false,"teams":[{"id":"rec-home","name":"Home","color":"#123456","players":[{"id":"rec-p1","name":"One","number":"09"}]},{"id":"rec-away","name":"Away","color":"#abcdef","players":[{"id":"rec-p2","name":"Two","number":"2"}]}]}';
  receipt jsonb; denied boolean;
begin
  receipt := public.rec_setup_game_once(actor, setup);
  if receipt <> '{"game_id":"rec-game"}'::jsonb then raise exception 'FAIL receipt'; end if;
  if (select count(*) from teams where league_id='rec-test') <> 2 or
     (select count(*) from players where league_id='rec-test') <> 2 then raise exception 'FAIL incomplete bundle'; end if;
  if (select number from players where id='rec-p1') <> '09' then raise exception 'FAIL jersey'; end if;
  if not exists (select 1 from games g join teams h on h.id=g.home_team_id join teams a on a.id=g.away_team_id
    where g.id='rec-game' and g.created_by=actor) then raise exception 'FAIL links/creator'; end if;
  update games set home_on_court=array['rec-p1'], period=3, status='final' where id='rec-game';
  update teams set name='Edited Home' where id='rec-home';
  update players set name='Edited Player' where id='rec-p1';
  perform public.rec_setup_game_once(actor, setup);
  if (select period from games where id='rec-game') <> 3 or (select status from games where id='rec-game') <> 'final'
    or (select name from teams where id='rec-home') <> 'Edited Home'
    or (select name from players where id='rec-p1') <> 'Edited Player' then raise exception 'FAIL retry overwrites'; end if;
  denied := false;
  begin perform public.rec_setup_game_once(actor, jsonb_set(setup,'{location}','"Changed"'));
  exception when raise_exception then denied := true; end;
  if not denied then raise exception 'FAIL changed replay'; end if;
  denied := false;
  begin perform public.rec_setup_game_once(actor, jsonb_set(setup,'{game_id}','"second"'));
  exception when raise_exception then denied := true; end;
  if not denied or exists(select 1 from games where id='second') then raise exception 'FAIL shared team collision'; end if;
  if (select name from teams where id='rec-home') <> 'Edited Home' then raise exception 'FAIL shared overwrite'; end if;
  update auth_state set uid='22222222-2222-2222-2222-222222222222';
  denied := false;
  begin perform public.rec_setup_game_once(actor, setup);
  exception when raise_exception then denied := true; end;
  if not denied then raise exception 'FAIL actor guard'; end if;
  denied := false;
  begin perform public.rec_setup_game_once('22222222-2222-2222-2222-222222222222', setup);
  exception when raise_exception then denied := true; end;
  if not denied then raise exception 'FAIL receipt ownership'; end if;
  update auth_state set uid=actor;
  -- A failure after league/team inserts rolls the entire transaction back.
  denied := false;
  begin perform public.rec_setup_game_once(actor,
    replace(replace(replace(setup::text,'rec-test','bad-space'),'rec-game','bad-game'),'rec-','bad-')::jsonb
      || '{"created_at":null}'::jsonb);
  exception when not_null_violation then denied := true; end;
  if not denied or exists(select 1 from leagues where id='bad-space') then raise exception 'FAIL atomic failure'; end if;
  denied := false;
  begin perform public.rec_setup_game_once(actor, replace(setup::text,'rec-','atomic-')::jsonb);
  exception when raise_exception then denied := true; end;
  if not denied or exists(select 1 from leagues where id='atomic-test')
    or exists(select 1 from teams where id like 'atomic-%')
    or exists(select 1 from players where id like 'atomic-%')
    or exists(select 1 from rec_setup_receipts where game_id='atomic-game') then raise exception 'FAIL late atomic rollback'; end if;
  perform public.rec_setup_game_once(actor,
    replace(setup::text,'rec-','private-')::jsonb || '{"shared":false}'::jsonb);
  if not exists(select 1 from league_members where league_id='private-test' and user_id=actor and role='owner') then raise exception 'FAIL private owner'; end if;
  delete from games where id='rec-game';
  denied := false;
  begin perform public.rec_setup_game_once(actor, setup);
  exception when raise_exception then denied := true; end;
  if not denied or exists(select 1 from games where id='rec-game') then raise exception 'FAIL resurrected deleted game'; end if;
  -- The legacy signature remains usable.
  perform public.rec_setup_game('old-rec','Old',true,1000,'old-game','Court',true,true,
    replace((setup->'teams')::text,'rec-','old-')::jsonb);
  if has_table_privilege('authenticated','public.rec_setup_receipts','SELECT')
    or has_function_privilege('anon','public.rec_setup_game_once(uuid,jsonb)','EXECUTE') then raise exception 'FAIL grants'; end if;
end $$;
set role authenticated;
do $$
declare result jsonb; denied boolean := false;
begin
  result := public.rec_setup_game_once('11111111-1111-1111-1111-111111111111',
    '{"league_id":"private-test","league_name":"Community","shared":false,"created_at":1000,"game_id":"private-game","location":"Court","track_misses":true,"track_turnovers":false,"teams":[{"id":"private-home","name":"Home","color":"#123456","players":[{"id":"private-p1","name":"One","number":"09"}]},{"id":"private-away","name":"Away","color":"#abcdef","players":[{"id":"private-p2","name":"Two","number":"2"}]}]}');
  if result->>'game_id' <> 'private-game' then raise exception 'FAIL authenticated execution'; end if;
  begin perform 1 from rec_setup_receipts; exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'FAIL private receipts'; end if;
end $$;
reset role;
insert into t_results values(true,'drop-in receipt, full bundle, replay, collisions, actor, private/public, rollback and legacy compatibility');
select case when ok then '  PASS  ' else '  FAIL  ' end || label from t_results;
select '  ' || count(*) filter (where ok) || ' passed, '
  || count(*) filter (where not ok) || ' failed   [rec_setup_receipts]' from t_results;
