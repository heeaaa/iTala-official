-- iTala Connect schedule: the mobile-side atomic Start RPC.
-- See the matching definition at the end of ../schema.sql.
create or replace function public.start_connect_game(
  p_league_id text,
  p_connect_game_id uuid,
  p_home_team_id text,
  p_away_team_id text,
  p_home_on_court text[],
  p_away_on_court text[],
  p_location text default null
) returns public.games
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id text := 'cg_' || p_connect_game_id::text;
  v_home public.teams%rowtype;
  v_away public.teams%rowtype;
  v_game public.games%rowtype;
begin
  if not exists (select 1 from public.leagues where id = p_league_id and kind = 'league' and not coalesce(is_closed, false))
     or not public.can_score(p_league_id) then
    raise exception 'You cannot start games in this league' using errcode = '42501';
  end if;
  select * into v_home from public.teams where id = p_home_team_id and league_id = p_league_id;
  select * into v_away from public.teams where id = p_away_team_id and league_id = p_league_id;
  if v_home.id is null or v_away.id is null or v_home.id = v_away.id then
    raise exception 'Both teams must belong to this league' using errcode = '22023';
  end if;
  if p_home_on_court is null or p_away_on_court is null
     or cardinality(p_home_on_court) > 5 or cardinality(p_away_on_court) > 5
     or (not v_home.team_only and cardinality(p_home_on_court) = 0)
     or (not v_away.team_only and cardinality(p_away_on_court) = 0)
     or (v_home.team_only and cardinality(p_home_on_court) <> 0)
     or (v_away.team_only and cardinality(p_away_on_court) <> 0)
     or not (v_home.player_ids @> p_home_on_court)
     or not (v_away.player_ids @> p_away_on_court)
     or (select count(*) from unnest(p_home_on_court) x) <> (select count(distinct x) from unnest(p_home_on_court) x)
     or (select count(*) from unnest(p_away_on_court) x) <> (select count(distinct x) from unnest(p_away_on_court) x)
  then
    raise exception 'Choose valid starting lineups' using errcode = '22023';
  end if;
  insert into public.games (
    id, league_id, home_team_id, away_team_id, status, scheduled_at,
    location, home_on_court, away_on_court, period
  ) values (
    v_id, p_league_id, p_home_team_id, p_away_team_id, 'live',
    floor(extract(epoch from now()) * 1000)::bigint,
    nullif(btrim(coalesce(p_location, '')), ''), p_home_on_court, p_away_on_court, 1
  ) on conflict (id) do nothing
  returning * into v_game;
  if v_game.id is null then
    select * into v_game from public.games where id = v_id;
    if v_game.id is null or v_game.league_id <> p_league_id
       or v_game.home_team_id <> p_home_team_id
       or v_game.away_team_id <> p_away_team_id then
      raise exception 'This fixture was already started with different teams' using errcode = '23505';
    end if;
  end if;
  return v_game;
end;
$$;
revoke all on function public.start_connect_game(text,uuid,text,text,text[],text[],text) from public, anon;
grant execute on function public.start_connect_game(text,uuid,text,text,text[],text[],text) to authenticated;
