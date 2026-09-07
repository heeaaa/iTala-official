-- @requires: legacy_legal_urls, legal
--
-- The itala.fyi domain move, against a project that already exists.
--
-- The three legal document URLs live in a seeded `legal_versions` row, and that
-- seed used `on conflict (version) do nothing`. So on any project already set
-- up, re-running schema.sql would have left the row pinned to the retired
-- `itala.abejohanna.workers.dev` host forever, while the shipped app opened the
-- new addresses: the acceptance receipt on file would cite a different URL from
-- the page the person actually read, and no amount of re-running the schema
-- would correct it.
--
-- `legacy_legal_urls` reproduces that project - same version, old URLs, already
-- current - and then the real `legal` section from schema.sql is loaded on top,
-- exactly as an operator re-running the script would. What follows checks that
-- the URLs heal and that nothing else moves with them.
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

create table public.url_results (n serial, label text not null, ok boolean not null);
create function public.url_assert(condition boolean, label text)
returns void language plpgsql as $$ begin
  insert into public.url_results (label, ok) values (label, coalesce(condition, false));
  if condition is distinct from true then raise exception 'FAIL: %', label; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The URLs healed.
-- ---------------------------------------------------------------------------
select url_assert(
  (select terms_url from public.legal_versions where version = '2026-09-07')
    = 'https://www.itala.fyi/terms/',
  'terms_url is rewritten to the current domain');
select url_assert(
  (select privacy_url from public.legal_versions where version = '2026-09-07')
    = 'https://www.itala.fyi/privacy/',
  'privacy_url is rewritten to the current domain');
select url_assert(
  (select content_policy_url from public.legal_versions where version = '2026-09-07')
    = 'https://www.itala.fyi/content-policy/',
  'content_policy_url is rewritten to the current domain');
select url_assert(not exists (
  select 1 from public.legal_versions
   where terms_url like '%workers.dev%'
      or privacy_url like '%workers.dev%'
      or content_policy_url like '%workers.dev%'
), 'no row still points at the retired host');

-- ---------------------------------------------------------------------------
-- 2. Nothing else moved.
-- ---------------------------------------------------------------------------
-- The documents are the same documents at a new address. Bumping the version
-- would force every existing user to re-accept unchanged terms, and would
-- orphan the receipts already on file.
select url_assert((select count(*) from public.legal_versions) = 1,
  'the move updates the existing version rather than adding one');
select url_assert(exists (select 1 from public.legal_versions where version = '2026-09-07'),
  'the version string is untouched, so existing receipts stay valid');

-- is_current is deliberately excluded from the conflict clause: re-running the
-- schema must never roll back an operator who has moved everyone to a newer
-- required version.
select url_assert(
  (select is_current from public.legal_versions where version = '2026-09-07') is true,
  'is_current survives the URL update');

-- A receipt taken before the move still resolves, and still reports the version
-- the person accepted - now carrying the address they can actually open.
insert into auth.users (id) values ('dddddddd-0000-0000-0000-000000000004')
on conflict (id) do nothing;
insert into public.legal_acceptances (user_id, version)
values ('dddddddd-0000-0000-0000-000000000004', '2026-09-07');
select url_assert(
  (select count(*) from public.legal_acceptances a
     join public.legal_versions v on v.version = a.version
    where a.user_id = 'dddddddd-0000-0000-0000-000000000004'
      and v.terms_url = 'https://www.itala.fyi/terms/') = 1,
  'an acceptance still joins to its version, and reads the new URL');

-- ---------------------------------------------------------------------------
-- 3. Idempotent. An operator re-runs schema.sql more than once.
-- ---------------------------------------------------------------------------
insert into public.legal_versions (version, terms_url, privacy_url, content_policy_url, is_current)
values ('2026-09-07', 'https://www.itala.fyi/terms/',
  'https://www.itala.fyi/privacy/',
  'https://www.itala.fyi/content-policy/',
  not exists (select 1 from public.legal_versions where is_current))
on conflict (version) do update set
  terms_url = excluded.terms_url,
  privacy_url = excluded.privacy_url,
  content_policy_url = excluded.content_policy_url;
select url_assert((select count(*) from public.legal_versions) = 1
  and (select is_current from public.legal_versions where version = '2026-09-07') is true,
  'a second re-run changes nothing');

-- report
select case when ok then '  PASS  ' else '  FAIL  ' end || label
  from public.url_results order by n;
select '  ' || count(*) filter (where ok) || ' passed, '
       || count(*) filter (where not coalesce(ok, false)) || ' failed   [legal_url_migration]'
  from public.url_results;
