\set ON_ERROR_STOP off
-- === TEST 1: Community (shared) drop-in game, league does not exist yet ===
select public.rec_setup_game(
  'rec-shared','Community Drop-in Games (Papawis)', true, 1720000000000,
  'game_A','Southridge Gym', true, true,
  '[{"id":"tA","name":"Team Alpha","color":"#12D7D0","players":[
      {"id":"p1","name":"Juan Dela Cruz","number":"17"},
      {"id":"p2","name":"Pedro Santos","number":"09"}]},
    {"id":"tB","name":"Team Bravo","color":"#C7F000","players":[
      {"id":"p3","name":"Maria Reyes","number":"7"},
      {"id":"p4","name":"Jose Cruz","number":""}]}]'::jsonb);

select 'league' src, id, name, is_shared::text from leagues
union all select 'team', id, name, color from teams
union all select 'player', id, name, coalesce(number,'(null)') from players
union all select 'game', id, home_team_id||' vs '||away_team_id, coalesce(location,'-') from games
order by src, id;
