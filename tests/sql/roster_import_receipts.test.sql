-- @requires: is_admin, games_created_by, authz, bulk_roster, roster_receipts
-- These assertions execute the shipped SQL, including old-client compatibility.
create table t_results (ok boolean, label text);
do $$
declare
  owner_id uuid := '11111111-1111-1111-1111-111111111111';
  other_id uuid := '22222222-2222-2222-2222-222222222222';
  roster jsonb := '[{"id":"ri-team","name":"Alpha","color":"#123456","players":[{"id":"ri-player","name":"Alex","number":"09"}]}]';
  receipt jsonb; denied boolean;
begin
  insert into leagues (id,name,season,kind,created_at) values
    ('ri-league','Import','S1','league',1), ('ri-old','Old','S1','league',1),
    ('ri-collision','Collision','S1','league',1), ('ri-empty','Empty','S1','league',1);
  insert into league_members (league_id,user_id,role) values
    ('ri-league',owner_id,'owner'), ('ri-old',owner_id,'owner'),
    ('ri-collision',owner_id,'owner'), ('ri-empty',owner_id,'owner');

  receipt := public.bulk_import_roster_once('ri-op','ri-league',owner_id,roster);
  if receipt <> '{"import_id":"ri-op","team_count":1,"player_count":1}'::jsonb then raise exception 'FAIL receipt'; end if;
  if (select number from players where id='ri-player') <> '09' then raise exception 'FAIL leading zero'; end if;
  if (select player_ids from teams where id='ri-team') <> array['ri-player'] then raise exception 'FAIL linkage'; end if;

  update players set name='Later edit' where id='ri-player';
  if public.bulk_import_roster_once('ri-op','ri-league',owner_id,roster) <> receipt then raise exception 'FAIL replay receipt'; end if;
  if (select name from players where id='ri-player') <> 'Later edit' then raise exception 'FAIL stale overwrite'; end if;
  if (select count(*) from players where league_id='ri-league') <> 1 then raise exception 'FAIL duplicate'; end if;

  denied := false;
  begin perform public.bulk_import_roster_once('ri-op','ri-league',owner_id,replace(roster::text,'Alex','Changed')::jsonb);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL changed payload accepted'; end if;
  denied := false;
  begin perform public.bulk_import_roster_once('second-op','ri-league',owner_id,roster);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL nonempty league accepted'; end if;

  -- A later player collision must roll back the earlier team insert and receipt.
  denied := false;
  begin perform public.bulk_import_roster_once('collision-op','ri-collision',owner_id,
    replace(roster::text,'ri-team','new-team')::jsonb);
  exception when unique_violation then denied := true; end;
  if not denied or exists (select 1 from teams where id='new-team')
      or exists (select 1 from roster_import_receipts where import_id='collision-op') then raise exception 'FAIL atomic collision'; end if;
  if (select name from players where id='ri-player') <> 'Later edit' then raise exception 'FAIL cross league overwrite'; end if;

  update auth_state set uid=other_id;
  denied := false;
  begin perform public.bulk_import_roster_once('stranger','ri-empty',other_id,roster);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL nonmember accepted'; end if;
  insert into league_members values ('ri-empty',other_id,'scorekeeper');
  denied := false;
  begin perform public.bulk_import_roster_once('actor-switch','ri-empty',owner_id,roster);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL switched account accepted'; end if;
  perform public.bulk_import_roster_once('scorer','ri-empty',other_id,
    replace(replace(roster::text,'ri-team','scorer-team'),'ri-player','scorer-player')::jsonb);

  update auth_state set uid=owner_id;
  -- The old signature still works on the updated schema and existing data survives.
  perform public.bulk_import_roster('ri-old',
    replace(replace(roster::text,'ri-team','old-team'),'ri-player','old-player')::jsonb);
  if not exists (select 1 from players where id='old-player') then raise exception 'FAIL legacy RPC'; end if;
  if has_table_privilege('authenticated','public.roster_import_receipts','SELECT')
    or has_table_privilege('anon','public.roster_import_receipts','INSERT') then raise exception 'FAIL receipt grants'; end if;
  if has_function_privilege('anon','public.bulk_import_roster_once(text,text,uuid,jsonb)','EXECUTE') then raise exception 'FAIL anon grant'; end if;
  delete from leagues where id='ri-league';
  if exists (select 1 from roster_import_receipts where import_id='ri-op') then raise exception 'FAIL receipt cascade'; end if;
end $$;

-- Call through the actual authenticated role, not only the harness's DB owner.
-- Replaying the scorekeeper's receipt also needs current scorekeeper membership.
update auth_state set uid='22222222-2222-2222-2222-222222222222';
set role authenticated;
do $$
declare receipt jsonb; denied boolean := false;
begin
  receipt := public.bulk_import_roster_once('scorer','ri-empty',
    '22222222-2222-2222-2222-222222222222',
    '[{"id":"scorer-team","name":"Alpha","color":"#123456","players":[{"id":"scorer-player","name":"Alex","number":"09"}]}]');
  if receipt->>'import_id' <> 'scorer' then raise exception 'FAIL authenticated RPC'; end if;
  begin perform 1 from public.roster_import_receipts;
  exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'FAIL authenticated direct receipt read'; end if;
end $$;
reset role;
-- Backup-password admins intentionally retain an anonymous auth session.
do $$
declare actor uuid := '11111111-1111-1111-1111-111111111111'; denied boolean;
  roster jsonb := '[{"id":"admin-team","name":"Admin team","players":[{"id":"admin-player","name":"Player","number":"09"}]}]';
begin
  update auth_state set uid=actor, anon=true;
  insert into profiles(id,is_admin) values(actor,true) on conflict(id) do update set is_admin=true;
  insert into leagues(id,name,season,kind,created_at) values('admin-import','Admin','S','league',1);
  perform public.bulk_import_roster_once('admin-op','admin-import',actor,roster);
  perform public.bulk_import_roster_once('admin-op','admin-import',actor,roster);
  if (select count(*) from players where league_id='admin-import') <> 1 then raise exception 'FAIL password admin replay'; end if;
  denied := false;
  begin perform public.bulk_import_roster_once('admin-op','admin-import','22222222-2222-2222-2222-222222222222',roster);
  exception when raise_exception then denied := true; end;
  if not denied then raise exception 'FAIL password admin actor mismatch'; end if;
  update profiles set is_admin=false where id=actor;
  insert into league_members values('admin-import',actor,'owner');
  denied := false;
  begin perform public.bulk_import_roster_once('admin-op','admin-import',actor,roster);
  exception when raise_exception then denied := true; end;
  if not denied then raise exception 'FAIL anonymous nonadmin accepted'; end if;
  delete from leagues where id='admin-import';
  update auth_state set anon=false;
end $$;
insert into t_results values (true, 'roster persistence, replay, edits, account guards, collisions, old RPC and grants');
select case when ok then '  PASS  ' else '  FAIL  ' end || label from t_results;
select '  ' || count(*) filter (where ok) || ' passed, '
  || count(*) filter (where not ok) || ' failed   [roster_import_receipts]' from t_results;
