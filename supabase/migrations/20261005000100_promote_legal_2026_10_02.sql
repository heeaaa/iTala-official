-- Promote the staged 2026-10-02 legal bundle in the MOBILE Supabase project, not Connect.
-- Push it only once 20261003000100_stage_legal_connect_privacy.sql is applied and
-- verified (docs/LEGAL_ACKNOWLEDGEMENT.md). Until it runs, the server keeps requiring
-- 2026-09-07; afterwards, builds that only know 2026-09-07 ask for an app update.
-- One DO statement makes the switch atomic even if the CLI does not wrap files.

do $$
declare v_current text;
begin
  execute 'lock table public.legal_versions in share row exclusive mode';
  if (select count(*) from public.legal_versions where is_current) <> 1 then
    raise exception 'Expected exactly one current legal version before promotion';
  end if;
  select version into v_current from public.legal_versions where is_current;
  if v_current not in ('2026-09-07', '2026-10-02') then
    raise exception 'Unexpected current legal version: %', v_current;
  end if;
  if not exists (
    select 1 from public.legal_versions
    where version = '2026-09-07'
      and privacy_url = 'https://www.itala.fyi/archive/2026-09-07/privacy/'
  ) or not exists (
    select 1 from public.legal_versions
    where version = '2026-10-02'
      and privacy_url = 'https://www.itala.fyi/privacy/'
  ) then
    raise exception 'Stage and verify both legal document versions first';
  end if;

  update public.legal_versions set is_current = false
  where version = '2026-09-07' and is_current;
  update public.legal_versions set is_current = true
  where version = '2026-10-02' and not is_current;

  if (select count(*) from public.legal_versions where is_current) <> 1
     or not exists (
       select 1 from public.legal_versions
       where version = '2026-10-02' and is_current
     ) then
    raise exception 'Legal version promotion did not reach the expected state';
  end if;
end $$;
