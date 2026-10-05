-- Connect owns this metadata; phones read it as part of their normal league sync.
alter table public.leagues add column if not exists connect_events jsonb not null default '[]';
alter table public.leagues add column if not exists connect_link_revision bigint not null default 0;
alter table public.leagues add column if not exists connect_link_checked_at bigint;

create or replace function public.protect_connect_link_state() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('postgres', 'supabase_admin', 'service_role') then return new; end if;
  if (tg_op = 'INSERT' and (new.connect_events <> '[]'::jsonb or new.connect_link_revision <> 0 or new.connect_link_checked_at is not null))
     or (tg_op = 'UPDATE' and (new.connect_events is distinct from old.connect_events
       or new.connect_link_revision is distinct from old.connect_link_revision
       or new.connect_link_checked_at is distinct from old.connect_link_checked_at)) then
    raise exception 'Connect link status is managed by the schedule service' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists protect_connect_link_state on public.leagues;
create trigger protect_connect_link_state before insert or update on public.leagues
for each row execute function public.protect_connect_link_state();

create or replace function public.apply_connect_link_snapshot(
  p_league_id text, p_events jsonb, p_revision bigint, p_checked_at bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_league public.leagues%rowtype;
begin
  if p_revision is null or p_revision < 1 or p_checked_at is null or p_checked_at < 1
     or p_events is null or jsonb_typeof(p_events) <> 'array'
     or jsonb_array_length(p_events) > 100 then
    raise exception 'Invalid Connect link snapshot' using errcode = '22023';
  end if;
  select * into v_league from public.leagues where id = p_league_id and kind = 'league' for update;
  if not found then return null; end if; -- Deleted mobile leagues need no further delivery.
  if p_revision >= v_league.connect_link_revision then
    update public.leagues set connect_events = p_events, connect_link_revision = p_revision,
      connect_link_checked_at = greatest(coalesce(connect_link_checked_at, 0), p_checked_at)
      where id = p_league_id returning * into v_league;
  end if;
  return jsonb_build_object('events', v_league.connect_events, 'revision', v_league.connect_link_revision,
    'checkedAt', v_league.connect_link_checked_at);
end $$;
revoke all on function public.apply_connect_link_snapshot(text,jsonb,bigint,bigint) from public, anon, authenticated;
grant execute on function public.apply_connect_link_snapshot(text,jsonb,bigint,bigint) to service_role;

-- Only a server-validated scheduled game receives an authorization. A cg_ ID alone is insufficient.
create table if not exists public.connect_game_authorizations (
  game_id text primary key,
  league_id text not null references public.leagues(id) on delete cascade,
  home_team_id text not null,
  away_team_id text not null
);
alter table public.connect_game_authorizations enable row level security;
revoke all on public.connect_game_authorizations from public, anon, authenticated;
create or replace function public.authorize_connect_game(
  p_league_id text, p_game_id text, p_home_team_id text, p_away_team_id text
) returns void language sql security definer set search_path = '' as $$
  insert into public.connect_game_authorizations(game_id, league_id, home_team_id, away_team_id)
    values (p_game_id, p_league_id, p_home_team_id, p_away_team_id)
  on conflict (game_id) do update set league_id = excluded.league_id,
    home_team_id = excluded.home_team_id, away_team_id = excluded.away_team_id;
$$;
revoke all on function public.authorize_connect_game(text,text,text,text) from public, anon, authenticated;
grant execute on function public.authorize_connect_game(text,text,text,text) to service_role;

create or replace function public.guard_connect_game_creation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_events jsonb;
begin
  -- Upserts for ongoing/historical games remain valid after a league is linked.
  if exists (select 1 from public.games where id = new.id) then return new; end if;
  select connect_events into v_events from public.leagues where id = new.league_id for share;
  if jsonb_array_length(coalesce(v_events, '[]'::jsonb)) > 0 and not exists (
    select 1 from public.connect_game_authorizations a where a.game_id = new.id
      and a.league_id = new.league_id and a.home_team_id = new.home_team_id and a.away_team_id = new.away_team_id
  ) then
    raise exception 'This league has a published iTala Connect schedule. Choose a game on the Schedule tab.' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists guard_connect_game_creation on public.games;
create trigger guard_connect_game_creation before insert on public.games
for each row execute function public.guard_connect_game_creation();
