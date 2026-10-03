-- @requires: legal
-- Exercise the actual staged migration and later promotion against the old live state.
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

create table public.legal_rollout_results (label text not null, ok boolean not null);
create function public.legal_rollout_assert(condition boolean, label text)
returns void language plpgsql as $$ begin
  if condition is distinct from true then raise exception 'FAIL: %', label; end if;
  insert into public.legal_rollout_results values (label, true);
end $$;

-- Reproduce production before this release, including an existing receipt.
update public.legal_versions set is_current = false where version = '2026-10-02';
update public.legal_versions set is_current = true,
  terms_url = 'https://www.itala.fyi/terms/',
  privacy_url = 'https://www.itala.fyi/privacy/',
  content_policy_url = 'https://www.itala.fyi/content-policy/'
where version = '2026-09-07';
insert into public.legal_acceptances (user_id, version, accepted_at)
values ('11111111-1111-1111-1111-111111111111', '2026-09-07', '2026-09-07T12:00:00Z');

\i supabase/migrations/20261003000100_stage_legal_connect_privacy.sql

select legal_rollout_assert(
  (select version = '2026-09-07' from public.legal_versions where is_current),
  'staging leaves the accepted version current');
select legal_rollout_assert(
  (select privacy_url = 'https://www.itala.fyi/archive/2026-09-07/privacy/'
   from public.legal_versions where version = '2026-09-07'),
  'old receipt points to archived text');
select legal_rollout_assert(
  (select not is_current and privacy_url = 'https://www.itala.fyi/privacy/'
   from public.legal_versions where version = '2026-10-02'),
  'new version is staged at the canonical URL');
select legal_rollout_assert(
  (select count(*) = 1 and min(accepted_at) = '2026-09-07T12:00:00Z'::timestamptz
   from public.legal_acceptances),
  'staging preserves the original receipt and timestamp');

-- The app ships inside this window and records the bundle the server reports:
-- the earlier one stays acceptable for an account without a receipt, and the
-- staged one is refused until promotion.
update auth_state set uid = '22222222-2222-2222-2222-222222222222';
select legal_rollout_assert(
  public.accept_legal('2026-09-07')->>'version' = '2026-09-07',
  'before promotion an account can still accept the earlier bundle');
do $$ begin
  perform public.accept_legal('2026-10-02');
  raise exception 'FAIL: the staged bundle was accepted before promotion';
exception when raise_exception then
  if sqlerrm <> 'Review the current legal version first' then raise; end if;
end $$;
select legal_rollout_assert(true, 'before promotion the staged bundle is refused');
delete from public.legal_acceptances where user_id = auth.uid();
update auth_state set uid = '11111111-1111-1111-1111-111111111111';

\i supabase/release/promote_legal_2026_10_02.sql

select legal_rollout_assert(
  (select version = '2026-10-02' from public.legal_versions where is_current),
  'promotion switches the current version');
select legal_rollout_assert(
  public.legal_status()->>'version' = '2026-10-02'
    and public.legal_status()->>'accepted_at' is null,
  'an earlier receipt requires acknowledgement of the new version');
select legal_rollout_assert(
  (select count(*) = 1 and min(version) = '2026-09-07'
   from public.legal_acceptances),
  'promotion preserves the earlier receipt');
do $$ begin
  perform public.accept_legal('2026-09-07');
  raise exception 'FAIL: the earlier bundle was accepted after promotion';
exception when raise_exception then
  if sqlerrm <> 'Review the current legal version first' then raise; end if;
end $$;
select legal_rollout_assert(true, 'after promotion the earlier bundle is refused');

-- Reapplying either operation must not reverse the current version.
\i supabase/migrations/20261003000100_stage_legal_connect_privacy.sql
\i supabase/release/promote_legal_2026_10_02.sql
select legal_rollout_assert(
  (select count(*) = 1 from public.legal_versions where is_current)
  and (select version = '2026-10-02' from public.legal_versions where is_current),
  'repeat runs keep exactly one current version');

select case when ok then '  PASS  ' else '  FAIL  ' end || label
  from public.legal_rollout_results order by label;
select '  ' || count(*) filter (where ok) || ' passed, '
       || count(*) filter (where not coalesce(ok, false)) || ' failed   [legal rollout]'
  from public.legal_rollout_results;
