\set ON_ERROR_STOP off
-- Reproduce: a PRIVATE drop-in league row already exists with NO membership
-- (left behind by an earlier failed attempt), and the user is NOT an admin.
insert into leagues values ('rec-u1','Private Drop-In Games','Drop-In','recreational',null,true,true,false,false,false,1720000000000);
select 'is_admin' lbl, public.is_admin()::text v
union all select 'member_role', coalesce(public.member_role('rec-u1'),'(none)')
union all select 'can_score', public.can_score('rec-u1')::text;
-- now try to create the drop-in game, exactly as the app does
select public.rec_setup_game('rec-u1','Private Drop-In Games', false, 1720000000000,
  'gP','Court', true, true,
  '[{"id":"tP1","name":"Reds","color":"#FF4D4F","players":[{"id":"pP1","name":"A","number":"1"}]},
    {"id":"tP2","name":"Blues","color":"#12D7D0","players":[{"id":"pP2","name":"B","number":"2"}]}]'::jsonb);
select 'teams written' lbl, count(*)::text v from teams where league_id='rec-u1'
union all select 'game written', count(*)::text from games where id='gP';

-- Security: a different user must NOT be able to claim an already-owned space.
update auth_state set uid = '22222222-2222-2222-2222-222222222222';
select public.rec_setup_game('rec-u1','Private Drop-In Games', false, 1720000000000,
  'gX','Court', true, true,
  '[{"id":"tX1","name":"X","color":"#fff","players":[]},{"id":"tX2","name":"Y","color":"#000","players":[]}]'::jsonb);
select 'owners on rec-u1 (must stay 1)' lbl, count(*)::text v from league_members where league_id='rec-u1';
update auth_state set uid = '11111111-1111-1111-1111-111111111111';
