\set ON_ERROR_STOP off
-- USER A creates a community drop-in game.
update auth_state set uid='aaaaaaaa-0000-0000-0000-000000000001', anon=false;
select public.rec_setup_game('rec-shared','Community Drop-in Games (Papawis)', true, 1720000000000,
  'gCOM','Gym', true, true,
  '[{"id":"cA","name":"Alpha","color":"#12D7D0","players":[{"id":"cp1","name":"A","number":"1"}]},
    {"id":"cB","name":"Bravo","color":"#C7F000","players":[{"id":"cp2","name":"B","number":"2"}]}]'::jsonb);
select 'creator stamped' lbl, (created_by = 'aaaaaaaa-0000-0000-0000-000000000001')::text v from games where id='gCOM';

-- CREATOR can score
select 'A (creator) can score' lbl, public.can_score_game('gCOM')::text v;

-- ANOTHER signed-in user must NOT be able to score it
update auth_state set uid='bbbbbbbb-0000-0000-0000-000000000002';
select 'B (other signed-in user) can score  [MUST BE false]' lbl, public.can_score_game('gCOM')::text v
union all select 'B can_score(league) old rule  [was true]', public.can_score('rec-shared')::text;

-- SUPER ADMIN can score anything
insert into profiles values ('cccccccc-0000-0000-0000-000000000003', true);
update auth_state set uid='cccccccc-0000-0000-0000-000000000003';
select 'C (super admin) can score' lbl, public.can_score_game('gCOM')::text v;

-- LEGACY community game with no creator: admin only
insert into games (id,league_id,home_team_id,away_team_id,status,scheduled_at,created_by)
  values ('gLEGACY','rec-shared','cA','cB','final',1719000000000,null);
select 'admin can score legacy' lbl, public.can_score_game('gLEGACY')::text v;
update auth_state set uid='bbbbbbbb-0000-0000-0000-000000000002';
select 'non-admin can score legacy  [MUST BE false]' lbl, public.can_score_game('gLEGACY')::text v;

-- PRIVATE rec + NORMAL league must be UNCHANGED (league rules still apply)
update auth_state set uid='aaaaaaaa-0000-0000-0000-000000000001';
insert into leagues values ('rec-a','Private Drop-In Games','Drop-In','recreational',null,true,true,false,false,false,1720000000000);
insert into league_members values ('rec-a','aaaaaaaa-0000-0000-0000-000000000001','owner');
insert into games (id,league_id,home_team_id,away_team_id,status,scheduled_at,created_by)
  values ('gPRIV','rec-a','x','y','live',1720000000000,null);
select 'private rec owner can score (created_by null)' lbl, public.can_score_game('gPRIV')::text v;
insert into leagues values ('lgN','BPBL','S3','league',null,true,true,false,false,false,1720000000000);
insert into league_members values ('lgN','aaaaaaaa-0000-0000-0000-000000000001','scorekeeper');
insert into games (id,league_id,home_team_id,away_team_id,status,scheduled_at,created_by)
  values ('gLGE','lgN','x','y','live',1720000000000,null);
select 'normal-league scorekeeper can score (created_by null)' lbl, public.can_score_game('gLGE')::text v;
