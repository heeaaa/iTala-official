-- iTala v2 :: 0001 :: extensions, profiles, shared helpers
--
-- Every function here is `security definer` with an explicit `search_path`.
-- That is deliberate hardening: without a pinned search_path a definer
-- function can be tricked into calling an attacker's shadowed object.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- profiles: one row per auth user, including anonymous ones.
-- `is_admin` IS the entire authorisation model.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table public.profiles is
  'One row per auth user. is_admin is flipped only by the security-definer RPCs; there is no write policy, so no client can set it directly.';

-- Created automatically for every new auth user, anonymous ones included.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Keeps updated_at honest. v1 declared these columns and never maintained
-- them, which made them look like optimistic-concurrency tokens when they
-- were not. Here they are genuinely maintained, purely as a debugging aid.
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- is_admin(): the predicate behind every write policy.
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- ---------------------------------------------------------------------------
-- can_write(): the ONLY predicate any write policy calls.
--
-- Today it ignores its argument and asks one global question. When per-user
-- accounts and league membership arrive, this function consults a memberships
-- table and every policy in the database starts enforcing per-league roles
-- without a single policy being rewritten. That is the whole point of the
-- indirection: one function to change, not fifty policies.
-- ---------------------------------------------------------------------------
create or replace function public.can_write(p_league_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin();
$$;

comment on function public.can_write(text) is
  'Write predicate for every domain table. Ignores p_league_id today; becomes a per-league membership check when invite-code accounts ship.';

-- ---------------------------------------------------------------------------
-- ping(): exists solely so the keep-alive job can register activity and stop
-- a free-tier project auto-pausing after 7 idle days. Deliberately harmless.
-- ---------------------------------------------------------------------------
create or replace function public.ping()
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select now();
$$;

grant execute on function public.ping() to anon, authenticated;
