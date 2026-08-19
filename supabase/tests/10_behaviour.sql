\set ON_ERROR_STOP on

-- Two users, as the anonymous sign-in flow would create them.
insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

do $$
begin
  if (select count(*) from public.profiles) <> 2 then
    raise exception 'FAIL: on_auth_user_created did not create profiles';
  end if;
  raise notice 'PASS: a profile row is created for every new auth user';
end $$;

-- The documented password-setting snippet, with a throwaway value.
insert into public.admin_secret (id, password_hash)
values (1, extensions.crypt('test-only-password', extensions.gen_salt('bf', 8)))
on conflict (id) do update set password_hash = excluded.password_hash;

do $$
declare h text;
begin
  select password_hash into h from public.admin_secret where id = 1;
  if h like '%test-only-password%' then
    raise exception 'FAIL: the password was stored in plaintext';
  end if;
  if left(h, 4) <> '$2a$' and left(h, 4) <> '$2b$' then
    raise exception 'FAIL: the stored value is not a bcrypt hash (got %)', left(h, 4);
  end if;
  raise notice 'PASS: the password is stored as a bcrypt hash, not plaintext';
end $$;

-- ---------------------------------------------------------------------------
-- Role 1: anonymous-unauthenticated. Must read NOTHING.
-- ---------------------------------------------------------------------------
set role anon;
select set_config('request.jwt.claim.sub', '', false);

do $$
declare n int;
begin
  select count(*) into n from public.leagues;
  if n <> 0 then raise exception 'FAIL: an unauthenticated caller read leagues'; end if;
  raise notice 'PASS: an unauthenticated caller reads nothing';
end $$;

do $$
begin
  begin
    insert into public.leagues (id, name, season, created_at) values ('x', 'X', 'S', 1);
    raise exception 'FAIL: an unauthenticated caller wrote a league';
  exception when insufficient_privilege then
    raise notice 'PASS: an unauthenticated write is refused by RLS';
  end;
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- Role 2: signed-in spectator. Reads everything, writes nothing.
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  begin
    insert into public.leagues (id, name, season, created_at) values ('x', 'X', 'S', 1);
    raise exception 'FAIL: a signed-in non-admin wrote a league';
  exception when insufficient_privilege then
    raise notice 'PASS: a signed-in non-admin cannot write';
  end;
end $$;

do $$
begin
  begin
    perform 1 from public.admin_secret;
    raise exception 'FAIL: a signed-in caller read admin_secret';
  exception when insufficient_privilege then
    raise notice 'PASS: admin_secret is unreadable through the API';
  end;
end $$;

-- Five wrong guesses, then lockout.
do $$
declare r jsonb; i int;
begin
  for i in 1..4 loop
    r := public.elevate_to_admin('wrong');
    if (r->>'reason') <> 'wrong_password' then
      raise exception 'FAIL: attempt % expected wrong_password, got %', i, r;
    end if;
    if (r->>'attempts_remaining')::int <> 5 - i then
      raise exception 'FAIL: attempt % reported % remaining', i, r->>'attempts_remaining';
    end if;
  end loop;

  r := public.elevate_to_admin('wrong');
  if (r->>'reason') <> 'locked' then
    raise exception 'FAIL: the fifth wrong guess did not lock out, got %', r;
  end if;
  raise notice 'PASS: five wrong guesses lock the caller out for % seconds', r->>'retry_after_seconds';

  -- The correct password must ALSO fail while locked out.
  r := public.elevate_to_admin('test-only-password');
  if (r->>'reason') <> 'locked' then
    raise exception 'FAIL: lockout did not hold against the correct password, got %', r;
  end if;
  raise notice 'PASS: lockout holds even against the correct password';

  if public.is_admin() then raise exception 'FAIL: a locked-out caller became admin'; end if;
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- Role 3: admin.
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);

do $$
declare r jsonb;
begin
  r := public.elevate_to_admin('test-only-password');
  if (r->>'ok') <> 'true' then raise exception 'FAIL: the correct password was rejected: %', r; end if;
  if not public.is_admin() then raise exception 'FAIL: elevation did not set is_admin'; end if;
  raise notice 'PASS: the correct password elevates the caller';
end $$;

insert into public.leagues (id, name, season, created_at) values ('lg1', 'Sunday Run', 'Spring 2026', 1000);
insert into public.teams (id, league_id, name, color) values
  ('tA', 'lg1', 'Riptide', '#3A78FF'), ('tB', 'lg1', 'Coastal', '#FF6B6B');
insert into public.players (id, league_id, name, number) values ('p1', 'lg1', 'Ana', '7');
insert into public.games (id, league_id, home_team_id, away_team_id, status, period)
  values ('g1', 'lg1', 'tA', 'tB', 'live', 1);
insert into public.events (id, league_id, game_id, team_id, player_id, type, period, ts)
  values ('e1', 'lg1', 'g1', 'tA', 'p1', 'fg3_make', 1, 1);

do $$ begin raise notice 'PASS: an admin can write every domain table'; end $$;

-- Constraints actually bite.
do $$
begin
  begin
    insert into public.events (id, league_id, game_id, team_id, type, period, ts)
      values ('bad1', 'lg1', 'g1', 'tA', 'oreb', 1, 1);
    raise exception 'FAIL: a dropped legacy event type was accepted';
  exception when check_violation then
    raise notice 'PASS: the events.type check constraint rejects a dropped type';
  end;

  begin
    insert into public.events (id, league_id, game_id, team_id, type, period, ts)
      values ('bad2', 'lg1', 'g1', 'tA', 'pf', 10, 1);
    raise exception 'FAIL: period 10 was accepted';
  exception when check_violation then
    raise notice 'PASS: period is constrained to 1..9';
  end;

  begin
    insert into public.games (id, league_id, home_team_id, away_team_id, status)
      values ('gbad', 'lg1', 'tA', 'tA', 'live');
    raise exception 'FAIL: a team was allowed to play itself';
  exception when check_violation then
    raise notice 'PASS: home and away must differ';
  end;

  begin
    insert into public.events (id, league_id, game_id, team_id, type, period, ts)
      values ('bad3', 'lg1', 'nope', 'tA', 'pf', 1, 1);
    raise exception 'FAIL: an event referencing a missing game was accepted';
  exception when foreign_key_violation then
    raise notice 'PASS: events.game_id is a real foreign key (v1 had none)';
  end;

  begin
    insert into public.games (id, league_id, home_team_id, away_team_id, status)
      values ('gbad2', 'lg1', 'tA', 'nope', 'live');
    raise exception 'FAIL: a game referencing a missing team was accepted';
  exception when foreign_key_violation then
    raise notice 'PASS: games.away_team_id is a real foreign key (this is v1 hole H-2)';
  end;
end $$;

-- Team-level events are legal and meaningful.
insert into public.events (id, league_id, game_id, team_id, player_id, type, period, ts, note)
  values ('e2', 'lg1', 'g1', 'tA', null, 'timeout', 1, 2, '4:28');
do $$ begin raise notice 'PASS: a team-level event with a null player_id is accepted'; end $$;

-- Locking drops the flag.
do $$
begin
  perform public.lock_admin();
  if public.is_admin() then raise exception 'FAIL: lock_admin did not clear is_admin'; end if;
  raise notice 'PASS: lock_admin drops the caller back to spectator';
end $$;

do $$
begin
  begin
    insert into public.leagues (id, name, season, created_at) values ('lg2', 'X', 'S', 1);
    raise exception 'FAIL: writes still worked after locking';
  exception when insufficient_privilege then
    raise notice 'PASS: writes stop immediately after locking';
  end;
end $$;

-- The keep-alive endpoint.
do $$
declare t timestamptz;
begin
  t := public.ping();
  if t is null then raise exception 'FAIL: ping returned null'; end if;
  raise notice 'PASS: ping() answers, so the keep-alive job has something to call';
end $$;

-- A spectator can still read what the admin wrote.
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
do $$
declare n int;
begin
  select count(*) into n from public.events;
  if n <> 2 then raise exception 'FAIL: a spectator saw % events, expected 2', n; end if;
  raise notice 'PASS: a signed-in spectator reads everything';
end $$;

reset role;
