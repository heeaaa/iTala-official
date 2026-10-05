-- Default games: official team result without player scoring events.
-- Apply before releasing the matching mobile app and Connect bridge.

alter table public.games add column if not exists default_winner_team_id text;
alter table public.games add column if not exists default_score int;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'games_default_result_check'
    and conrelid = 'public.games'::regclass) then
    alter table public.games add constraint games_default_result_check check (
      (default_winner_team_id is null and default_score is null) or
      (status = 'final' and default_winner_team_id is not null and default_score is not null
        and default_winner_team_id in (home_team_id, away_team_id)
        and default_score between 1 and 999)
    );
  end if;
end $$;

create or replace view public.final_game_scores
-- security_invoker: the view runs with the CALLER's permissions, so the existing
-- row-level security on games/events/teams still applies and this exposes
-- nothing that a signed-in session could not already read row by row. Without
-- it the view would run as its owner and silently bypass RLS - a private
-- league's scores would leak to anyone granted select here.
with (security_invoker = on) as
select
  g.id                          as game_id,
  g.league_id                   as league_id,
  l.name                        as league_name,
  l.season                      as season,
  g.home_team_id                as home_team_id,
  ht.name                       as home_name,
  g.away_team_id                as away_team_id,
  aw.name                       as away_name,
  (case when g.default_winner_team_id is not null then
    case when g.default_winner_team_id = g.home_team_id then g.default_score else 0 end
    else coalesce(s.home_pts, 0) end)::int as home_pts,
  (case when g.default_winner_team_id is not null then
    case when g.default_winner_team_id = g.away_team_id then g.default_score else 0 end
    else coalesce(s.away_pts, 0) end)::int as away_pts,
  -- BASKETBALL HAS NO DRAWS, but a level score still reaches here: a game
  -- finished with no events at all is 0-0, and the tracker lets a scorekeeper
  -- finish one after a warning (see standings() in src/lib/stats.ts). Such a
  -- game has NO result and must never resolve as a home win - that was the F-11
  -- `home >= away` bug. Exposing the winner rather than leaving each consumer to
  -- compare the two columns is what stops that bug being rewritten downstream.
  case
    when g.default_winner_team_id is not null then g.default_winner_team_id
    when coalesce(s.home_pts, 0) > coalesce(s.away_pts, 0) then g.home_team_id
    when coalesce(s.away_pts, 0) > coalesce(s.home_pts, 0) then g.away_team_id
    else null
  end                           as winner_team_id,
  g.finished_at                 as finished_at,
  -- finished_at is the client's Date.now(), i.e. epoch MILLISECONDS. Offered as
  -- a real timestamp too so a consumer never has to guess the unit.
  to_timestamp(g.finished_at / 1000.0) as finished_at_ts,
  -- Completeness signals, not decoration. See WHAT A ROW ACTUALLY PROMISES
  -- above: a replayed offline tap is INSERTed late, so last_event_at (the
  -- server's own clock, not the device's) moves when events are still arriving
  -- for a game that already reads final. A consumer that wants to be sure it has
  -- the whole game waits for these two to stop changing before it publishes.
  coalesce(s.event_count, 0)::int as event_count,
  s.last_event_at               as last_event_at,
  (g.default_winner_team_id is not null) as is_default
from public.games g
join public.leagues l on l.id = g.league_id
-- LEFT joins: games.home_team_id/away_team_id carry no foreign key to teams, so
-- a game whose team row is gone must still report its score with a null name,
-- not vanish from the view.
left join public.teams ht on ht.id = g.home_team_id
left join public.teams aw on aw.id = g.away_team_id
left join lateral (
  select
    -- Credited by EXACT team_id match, which is the rule teamBoxScore() applies
    -- in src/lib/stats.ts: an event stamped with any other team is credited to
    -- neither side there, so these filters must not credit it to one here.
    sum(public.event_points(e.type)) filter (where e.team_id = g.home_team_id) as home_pts,
    sum(public.event_points(e.type)) filter (where e.team_id = g.away_team_id) as away_pts,
    -- Deliberately unfiltered: these describe what the server HOLDS for this
    -- game, which is the question a consumer checking for late arrivals is
    -- asking. They are not part of the score.
    count(*)                                                                   as event_count,
    max(e.created_at)                                                          as last_event_at
  from public.events e
  where e.game_id = g.id
) s on true
where g.status = 'final';

-- Same audience as the underlying tables: any signed-in session (RLS then
-- decides which rows), plus service_role for a trusted server-side scheduler.
grant select on public.final_game_scores to authenticated, service_role;

-- The REVOKE is the load-bearing half, not the grant list. A Supabase project
-- carries `alter default privileges ... grant all on tables to anon,
-- authenticated, service_role`, so a view created by running this file through
-- the SQL editor can pick up anon SELECT on its own - omitting anon above does
-- not withhold it. Saying so explicitly is what makes the intent true rather
-- than merely stated.
--
-- Even so, the real protection is `security_invoker = on` plus the read_all_*
-- policies: they are why an anon-key caller reads zero rows through this view
-- whatever the grants say. This revoke is defence in depth on top of that.
revoke select on public.final_game_scores from anon;

-- A default fixture is final at creation. No lineup or event can represent its
-- team-only points, and the existing start RPC intentionally requires lineups.
create or replace function public.record_connect_default_game(
  p_league_id text,
  p_connect_game_id uuid,
  p_home_team_id text,
  p_away_team_id text,
  p_winner_team_id text,
  p_default_score int,
  p_location text default null
) returns public.games
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id text := 'cg_' || p_connect_game_id::text;
  v_game public.games%rowtype;
begin
  if not exists (select 1 from public.leagues where id = p_league_id and kind = 'league' and not coalesce(is_closed, false))
     or not public.can_score(p_league_id) then
    raise exception 'You cannot record games in this league' using errcode = '42501';
  end if;
  if p_home_team_id = p_away_team_id
     or not exists (select 1 from public.teams where id = p_home_team_id and league_id = p_league_id)
     or not exists (select 1 from public.teams where id = p_away_team_id and league_id = p_league_id)
     or p_winner_team_id is null or p_winner_team_id not in (p_home_team_id, p_away_team_id)
     or p_default_score is null or p_default_score not between 1 and 999 then
    raise exception 'Choose valid teams and a default score' using errcode = '22023';
  end if;
  insert into public.games (
    id, league_id, home_team_id, away_team_id, status, scheduled_at, finished_at,
    location, home_on_court, away_on_court, period, default_winner_team_id, default_score
  ) values (
    v_id, p_league_id, p_home_team_id, p_away_team_id, 'final',
    floor(extract(epoch from now()) * 1000)::bigint,
    floor(extract(epoch from now()) * 1000)::bigint,
    nullif(btrim(coalesce(p_location, '')), ''), '{}', '{}', 1,
    p_winner_team_id, p_default_score
  ) on conflict (id) do nothing returning * into v_game;
  if v_game.id is null then
    select * into v_game from public.games where id = v_id;
    if v_game.id is null or v_game.league_id <> p_league_id
       or v_game.home_team_id <> p_home_team_id or v_game.away_team_id <> p_away_team_id
       or v_game.status <> 'final' or v_game.default_winner_team_id is distinct from p_winner_team_id
       or v_game.default_score is distinct from p_default_score then
      raise exception 'This fixture already has a different result' using errcode = '23505';
    end if;
  end if;
  return v_game;
end;
$$;
revoke all on function public.record_connect_default_game(text,uuid,text,text,text,int,text) from public, anon;
grant execute on function public.record_connect_default_game(text,uuid,text,text,text,int,text) to authenticated;
