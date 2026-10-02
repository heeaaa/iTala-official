-- @requires: legacy_legal_urls, legal
-- A project with the retired workers.dev URLs and an accepted September version.
-- The real legal section from schema.sql has already been loaded by the runner.
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

create table public.url_results (n serial, label text not null, ok boolean not null);
create function public.url_assert(condition boolean, label text)
returns void language plpgsql as $$ begin
  insert into public.url_results (label, ok) values (label, coalesce(condition, false));
  if condition is distinct from true then raise exception 'FAIL: %', label; end if;
end $$;

select url_assert(
  (select terms_url = 'https://www.itala.fyi/archive/2026-09-07/terms/'
   from public.legal_versions where version = '2026-09-07'),
  'old terms URL is rewritten to the September archive');
select url_assert(
  (select privacy_url = 'https://www.itala.fyi/archive/2026-09-07/privacy/'
   from public.legal_versions where version = '2026-09-07'),
  'old privacy URL is rewritten to the September archive');
select url_assert(
  (select content_policy_url = 'https://www.itala.fyi/archive/2026-09-07/content-policy/'
   from public.legal_versions where version = '2026-09-07'),
  'old content URL is rewritten to the September archive');
select url_assert(not exists (
  select 1 from public.legal_versions
   where terms_url like '%workers.dev%'
      or privacy_url like '%workers.dev%'
      or content_policy_url like '%workers.dev%'
), 'no row still points at the retired host');

select url_assert((select count(*) from public.legal_versions) = 2,
  'the revised policy has a separately staged version');
select url_assert(
  (select is_current from public.legal_versions where version = '2026-09-07') is true
  and (select is_current from public.legal_versions where version = '2026-10-02') is false,
  'staging preserves the accepted September version as current');

insert into auth.users (id) values ('dddddddd-0000-0000-0000-000000000004')
on conflict (id) do nothing;
insert into public.legal_acceptances (user_id, version)
values ('dddddddd-0000-0000-0000-000000000004', '2026-09-07');
select url_assert(
  (select count(*) from public.legal_acceptances a
     join public.legal_versions v on v.version = a.version
    where a.user_id = 'dddddddd-0000-0000-0000-000000000004'
      and v.terms_url = 'https://www.itala.fyi/archive/2026-09-07/terms/') = 1,
  'an old acceptance still resolves to the text that was accepted');

-- The tracked migration is safe to reapply without changing the current row.
\i supabase/migrations/20261003000100_stage_legal_connect_privacy.sql
select url_assert(
  (select count(*) = 2 from public.legal_versions)
  and (select version = '2026-09-07' from public.legal_versions where is_current),
  'repeat staging preserves exactly two versions and the current receipt');

select case when ok then '  PASS  ' else '  FAIL  ' end || label
  from public.url_results order by n;
select '  ' || count(*) filter (where ok) || ' passed, '
       || count(*) filter (where not coalesce(ok, false)) || ' failed   [legal_url_migration]'
  from public.url_results;
