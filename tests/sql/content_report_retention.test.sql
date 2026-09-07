-- @requires: is_admin, content_reports, account_deletion
--
-- What happens to a content report when its reporter deletes their account.
--
-- This is a CHARACTERIZATION suite, not a wish list. `content_reports.
-- reporter_user_id` is a uuid with no foreign key and no on-delete behaviour,
-- so `delete_own_account` removes auth.users and cascades to profiles while the
-- report keeps the former app-session id. That is deliberate - an open report
-- has to stay attributable while it is being resolved - and because it is a
-- retention decision it is disclosed in the in-app deletion confirmation and in
-- the privacy policy, section 10.
--
-- The point of pinning it here is that the retention and the disclosure have to
-- move together. Adding `references auth.users(id) on delete cascade` later
-- would silently make the disclosure wrong (and destroy open reports); adding
-- `on delete set null` would leave a queue of complaints nobody can resolve.
-- Either change fails this suite, which is the prompt to revisit the wording
-- rather than a bug report.
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

grant usage on schema public, auth to anon, authenticated;
grant select on public.auth_state to anon, authenticated;

create table public.retention_results (n serial, label text not null, ok boolean not null);
-- SECURITY DEFINER because half of these assertions run with `set role
-- authenticated` (that is the whole point - they exercise the grants a device
-- actually has), and that role must not be given write access to the results
-- table just so the harness can record a line.
create function public.retention_assert(condition boolean, label text)
returns void language plpgsql security definer set search_path = public as $$ begin
  insert into public.retention_results (label, ok) values (label, coalesce(condition, false));
  if condition is distinct from true then raise exception 'FAIL: %', label; end if;
end $$;
grant execute on function public.retention_assert(boolean, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. The shape the disclosure depends on.
-- ---------------------------------------------------------------------------
select retention_assert(not exists (
  select 1
    from pg_constraint c
    join pg_class t       on t.oid = c.conrelid
    join pg_class r       on r.oid = c.confrelid
    join pg_namespace rns on rns.oid = r.relnamespace
   where t.relname = 'content_reports'
     and c.contype = 'f'
     and rns.nspname = 'auth'
     and r.relname = 'users'
), 'reporter_user_id has no foreign key to auth.users, by design');

select retention_assert(
  (select attnotnull from pg_attribute
    where attrelid = 'public.content_reports'::regclass and attname = 'reporter_user_id'),
  'reporter_user_id stays NOT NULL, so a report can never become unattributable');

-- Nobody may delete a report through the client. Retention is a decision made
-- by whoever reviews the queue, not something a reporter can force.
select retention_assert(not has_table_privilege('authenticated', 'public.content_reports', 'DELETE'),
  'clients cannot delete content reports');
select retention_assert(not has_table_privilege('anon', 'public.content_reports', 'DELETE'),
  'guest sessions cannot delete content reports');
select retention_assert(not exists (
  select 1 from pg_policies where tablename = 'content_reports' and cmd = 'DELETE'
), 'there is deliberately no delete policy on content_reports');

-- ---------------------------------------------------------------------------
-- 2. A real report, submitted through the RPC a device actually calls.
-- ---------------------------------------------------------------------------
insert into public.leagues (id, name, season, kind, created_at)
values ('lg-report', 'Retention League', 'S1', 'league', 1);
insert into public.teams (id, league_id, name, color) values ('tm-report', 'lg-report', 'Reporters', '#000');
insert into public.players (id, league_id, name) values ('pl-report', 'lg-report', 'Reported Player');
update public.teams set player_ids = array['pl-report'] where id = 'tm-report';

-- profiles carries the real FK from schema.sql (harness.sql's stub table has no
-- constraints), so the cascade this suite contrasts against actually happens.
insert into public.profiles (id, is_admin) values ('11111111-1111-1111-1111-111111111111', false);
alter table public.profiles
  add constraint profiles_auth_users_fk foreign key (id) references auth.users(id) on delete cascade;

update auth_state set uid = '11111111-1111-1111-1111-111111111111', anon = false;
set role authenticated;
select retention_assert(
  (submit_content_report('player', 'pl-report', 'lg-report', 'tm-report',
                         'Incorrect information', 'Please correct this.', 'reporter@example.invalid',
                         'req-retention-1') ->> 'reference') like 'ITR-%',
  'a signed-in session can submit a report');
reset role;

select retention_assert(
  (select count(*) from public.content_reports
    where reporter_user_id = '11111111-1111-1111-1111-111111111111') = 1,
  'the report is stored against the submitting session');

-- ---------------------------------------------------------------------------
-- 3. Delete the account, exactly as the app does.
-- ---------------------------------------------------------------------------
set role authenticated;
select delete_own_account();
reset role;

select retention_assert(not exists (
  select 1 from auth.users where id = '11111111-1111-1111-1111-111111111111'
), 'the auth.users row is gone');
select retention_assert(not exists (
  select 1 from public.profiles where id = '11111111-1111-1111-1111-111111111111'
), 'the profile is gone, cascaded from auth.users');

-- The finding this suite exists for. The report SURVIVES, and it keeps the id.
select retention_assert(
  (select count(*) from public.content_reports) = 1,
  'the report survives deletion of the account that submitted it');
select retention_assert(
  (select reporter_user_id from public.content_reports)
    = '11111111-1111-1111-1111-111111111111',
  'the retained app-session identifier is unchanged, not nulled');
select retention_assert(
  (select contact_email from public.content_reports) = 'reporter@example.invalid',
  'the contact address supplied with the report is retained with it');

-- ...and what "no longer connected to an active iTala account" means in SQL:
-- the id no longer joins to anything.
select retention_assert(not exists (
  select 1 from public.content_reports r join auth.users u on u.id = r.reporter_user_id
), 'the retained identifier resolves to no account');
select retention_assert(not exists (
  select 1 from public.content_reports r join public.profiles p on p.id = r.reporter_user_id
), 'the retained identifier resolves to no profile');

-- The report also stays usable: a Super Admin can still read and resolve it,
-- which is the whole justification for keeping it.
update auth_state set uid = '22222222-2222-2222-2222-222222222222', anon = false;
update public.profiles set is_admin = true where id = '22222222-2222-2222-2222-222222222222';
insert into public.profiles (id, is_admin)
values ('22222222-2222-2222-2222-222222222222', true)
on conflict (id) do update set is_admin = true;
set role authenticated;
select retention_assert((select count(*) from public.content_reports) = 1,
  'an admin can still read the orphaned report');
update public.content_reports set status = 'Resolved', resolution_note = 'Corrected.';
select retention_assert((select status from public.content_reports) = 'Resolved',
  'an admin can still resolve the orphaned report');
reset role;

-- report
select case when ok then '  PASS  ' else '  FAIL  ' end || label
  from public.retention_results order by n;
select '  ' || count(*) filter (where ok) || ' passed, '
       || count(*) filter (where not coalesce(ok, false)) || ' failed   [content_report_retention]'
  from public.retention_results;
