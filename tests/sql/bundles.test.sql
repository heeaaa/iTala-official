\set ON_ERROR_STOP off
-- === TEST 2: PRIVATE drop-in game → creator must become owner ===
select public.rec_setup_game('rec-mine','Private Drop-In Games', false, 1720000001000,
  'game_B','Barangay Court', true, false,
  '[{"id":"tC","name":"Reds","color":"#FF4D4F","players":[{"id":"p5","name":"Ana","number":"1"}]},
    {"id":"tD","name":"Blues","color":"#12D7D0","players":[{"id":"p6","name":"Ben","number":"2"}]}]'::jsonb);
select 'PRIVATE owner row:' lbl, count(*)::text v from league_members where league_id='rec-mine' and role='owner'
union all select 'SHARED owner row (must be 0):', count(*)::text from league_members where league_id='rec-shared';

-- === TEST 3: idempotency — replay the SAME call (simulates a retry) ===
select public.rec_setup_game('rec-shared','Community Drop-in Games (Papawis)', true, 1720000000000,
  'game_A','Southridge Gym', true, true,
  '[{"id":"tA","name":"Team Alpha","color":"#12D7D0","players":[{"id":"p1","name":"Juan Dela Cruz","number":"17"},{"id":"p2","name":"Pedro Santos","number":"09"}]},
    {"id":"tB","name":"Team Bravo","color":"#C7F000","players":[{"id":"p3","name":"Maria Reyes","number":"7"},{"id":"p4","name":"Jose Cruz","number":""}]}]'::jsonb);
select 'after replay — games:' lbl, count(*)::text v from games
union all select 'after replay — teams:', count(*)::text from teams
union all select 'after replay — players:', count(*)::text from players;

-- === TEST 4: missing color / missing name (the NOT NULL trap) ===
select public.rec_setup_game('rec-shared','Community', true, 1720000002000,
  'game_C','', null, null,
  '[{"id":"tE","name":"","players":[{"id":"p7","name":"","number":"5"}]},
    {"id":"tF","name":"Yellows","players":[{"id":"p8","name":"Cara","number":"6"}]}]'::jsonb);
select 'fallback team name/color:' lbl, name||' / '||color v from teams where id='tE'
union all select 'fallback player name:', name from players where id='p7'
union all select 'empty location → null:', coalesce(location,'NULL') from games where id='game_C';

-- === TEST 5: bulk import roster ===
insert into leagues values ('lg1','BPBL','S3','league',null,true,true,false,false,false,1720000003000);
insert into league_members values ('lg1','11111111-1111-1111-1111-111111111111','owner');
select public.bulk_import_roster('lg1',
  '[{"id":"bt1","name":"Joyboys North","color":"#12D7D0","players":[
      {"id":"bp1","name":"Juan A","number":"17"},{"id":"bp2","name":"Juan B","number":"420"}]},
    {"id":"bt2","name":"Philcan grind","color":"#C7F000","players":[
      {"id":"bp3","name":"Juan C","number":"09"},{"id":"bp4","name":"Juan D","number":""}]}]'::jsonb);
select 'bulk teams:' lbl, count(*)::text v from teams where league_id='lg1'
union all select 'bulk players:', count(*)::text from players where league_id='lg1'
union all select 'player_ids wired on bt1:', array_to_string(player_ids,',') from teams where id='bt1'
union all select 'leading zero kept:', number from players where id='bp3'
union all select 'unusual number kept:', number from players where id='bp2';
