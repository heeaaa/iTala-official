-- @requires: legacy_admin_allowlist, admin_allowlist
--
-- Retiring an admin, against a project that is already running.
--
-- The trap this suite exists for: deleting an address from the seed list looks
-- like a removal and revokes nothing at all.
--
--   * the seed is `insert ... on conflict (email) do nothing`, so an existing
--     row is left exactly where it was;
--   * `sync_admin_role` only ever sets `is_admin = true` - never false, by
--     design, so it cannot undo the password-elevation backup - which means
--     `profiles.is_admin` stays true forever and RLS keeps admitting the
--     writes.
--
-- So the shipped schema carries an explicit delete-and-demote block. This suite
-- loads a four-admin project (`legacy_admin_allowlist`), applies the real
-- shipped block on top, and checks that exactly the two retired people lost
-- access and nobody else was touched.
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- The fixture (`legacy_admin_allowlist` in run.js) seeds the four allowlisted
-- addresses, three already-flagged admin profiles, and their auth.users emails
-- - including one profile with no cached profiles.email, so the demote has to
-- resolve that address through auth.users.

create table public.retire_results (n serial, label text not null, ok boolean not null);
create function public.retire_assert(condition boolean, label text)
returns void language plpgsql as $$ begin
  insert into public.retire_results (label, ok) values (label, coalesce(condition, false));
  if condition is distinct from true then raise exception 'FAIL: %', label; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The allowlist rows are actually gone, not merely unmentioned.
-- ---------------------------------------------------------------------------
select retire_assert(not exists (
  select 1 from public.admin_emails where lower(email) = 'aeronjosephsantos@gmail.com'
), 'the retired row is deleted, not left behind by `do nothing`');
select retire_assert(not exists (
  select 1 from public.admin_emails where lower(email) = 'santos.ajhea@gmail.com'
), 'the second retired row is deleted too');
select retire_assert(
  (select count(*) from public.admin_emails) = 2,
  'exactly the two retained admins remain allowlisted');
select retire_assert(exists (
  select 1 from public.admin_emails where lower(email) = 'abejohanna@gmail.com'
) and exists (
  select 1 from public.admin_emails where lower(email) = 'abejoharold@gmail.com'
), 'the retained admins are untouched');

-- ---------------------------------------------------------------------------
-- 2. The already-granted flag is cleared. This is the half that omission
--    cannot do, and the half that RLS actually reads.
-- ---------------------------------------------------------------------------
select retire_assert(
  (select is_admin from public.profiles where id = 'eeeeeeee-0000-0000-0000-000000000002') is false,
  'a retired admin loses profiles.is_admin');
select retire_assert(
  (select is_admin from public.profiles where id = 'eeeeeeee-0000-0000-0000-000000000003') is false,
  'and so does one whose address is only on auth.users, not cached on the profile');
select retire_assert(
  (select is_admin from public.profiles where id = 'eeeeeeee-0000-0000-0000-000000000001') is true,
  'a retained admin keeps is_admin - the demote must not be a blanket reset');

-- ---------------------------------------------------------------------------
-- 3. is_admin() - what RLS calls - agrees.
-- ---------------------------------------------------------------------------
update auth_state set uid = 'eeeeeeee-0000-0000-0000-000000000002', anon = false;
select retire_assert(public.is_admin() is false, 'is_admin() refuses a retired admin');
update auth_state set uid = 'eeeeeeee-0000-0000-0000-000000000001', anon = false;
select retire_assert(public.is_admin() is true, 'is_admin() still admits a retained admin');

-- ---------------------------------------------------------------------------
-- 4. Idempotent, and it does not resurrect anybody.
-- ---------------------------------------------------------------------------
do $$
declare retired text[] := array['aeronjosephsantos@gmail.com', 'santos.ajhea@gmail.com'];
begin
  delete from public.admin_emails where lower(email) = any (retired);
  update public.profiles p
     set is_admin = false
   where p.is_admin
     and lower(coalesce((select u.email from auth.users u where u.id = p.id), p.email))
           = any (retired);
end $$;
select retire_assert((select count(*) from public.admin_emails) = 2
  and (select is_admin from public.profiles where id = 'eeeeeeee-0000-0000-0000-000000000001') is true,
  'a second schema run changes nothing further');

-- A retired person signing in again must NOT be re-promoted: the allowlist no
-- longer has them, so sync_admin_role's `allowed` test fails. Reproduced here
-- with the same existence check that function performs.
select retire_assert(not exists (
  select 1 from public.admin_emails a
   where lower(a.email) = lower((select email from auth.users
                                  where id = 'eeeeeeee-0000-0000-0000-000000000002'))
), 'signing in again does not re-promote a retired admin');

-- report
select case when ok then '  PASS  ' else '  FAIL  ' end || label
  from public.retire_results order by n;
select '  ' || count(*) filter (where ok) || ' passed, '
       || count(*) filter (where not coalesce(ok, false)) || ' failed   [admin_allowlist_retirement]'
  from public.retire_results;
