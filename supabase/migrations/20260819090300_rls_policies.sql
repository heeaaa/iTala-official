-- iTala v2 :: 0004 :: row-level security
--
-- THIS IS THE ONLY REAL ENFORCEMENT IN THE SYSTEM. Every isAdmin check in the
-- client is cosmetic and the client knows it.
--
-- Three roles fall out of the policies below:
--   anonymous-unauthenticated  reads nothing  (every policy needs auth.uid())
--   signed-in spectator        reads everything, writes nothing
--   admin                      reads and writes everything
--
-- Note what is deliberately absent: there is no per-league read restriction.
-- Any signed-in user, including anyone who installs the app and gets an
-- anonymous session, can read every league in the database. That is coherent
-- for one organisation running its own project, and it is the single largest
-- constraint on this design. Making it per-league is a data-model change, not
-- a feature. It is written down here so nobody has to rediscover it.

alter table public.profiles enable row level security;
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select using (auth.uid() = id);
-- NO write policy on profiles, deliberately. is_admin can only be changed by
-- the security-definer RPCs, never by a client.

-- Domain tables: read for any signed-in user, write gated by can_write().
do $$
declare t text;
begin
  foreach t in array array['leagues', 'teams', 'players', 'games', 'events'] loop
    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists "read_all_%1$s" on public.%1$I', t);
    execute format(
      'create policy "read_all_%1$s" on public.%1$I
         for select using (auth.uid() is not null)', t);

    execute format('drop policy if exists "write_%1$s" on public.%1$I', t);
    if t = 'leagues' then
      execute format(
        'create policy "write_%1$s" on public.%1$I
           for all using (public.can_write(id)) with check (public.can_write(id))', t);
    else
      execute format(
        'create policy "write_%1$s" on public.%1$I
           for all using (public.can_write(league_id)) with check (public.can_write(league_id))', t);
    end if;
  end loop;
end;
$$;
