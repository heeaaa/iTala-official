-- Stage the 2026-10-02 legal bundle in the MOBILE Supabase project.
-- The current acknowledgement version is deliberately not changed here.
-- Publish and verify the September archive pages before applying this migration.
-- One DO statement keeps the checks and writes atomic on every CLI version.

do $$
declare v_current text;
begin
  execute 'lock table public.legal_versions in share row exclusive mode';
  if (select count(*) from public.legal_versions where is_current) <> 1 then
    raise exception 'Expected exactly one current legal version before staging';
  end if;
  select version into v_current from public.legal_versions where is_current;
  if v_current not in ('2026-09-07', '2026-10-02') then
    raise exception 'Unexpected current legal version: %', v_current;
  end if;
  if not exists (select 1 from public.legal_versions where version = '2026-09-07') then
    raise exception 'The 2026-09-07 legal version is missing';
  end if;

  update public.legal_versions
  set terms_url = 'https://www.itala.fyi/archive/2026-09-07/terms/',
      privacy_url = 'https://www.itala.fyi/archive/2026-09-07/privacy/',
      content_policy_url = 'https://www.itala.fyi/archive/2026-09-07/content-policy/'
  where version = '2026-09-07';

  insert into public.legal_versions
    (version, terms_url, privacy_url, content_policy_url, is_current)
  values
    ('2026-10-02', 'https://www.itala.fyi/terms/',
     'https://www.itala.fyi/privacy/',
     'https://www.itala.fyi/content-policy/', false)
  on conflict (version) do update set
    terms_url = excluded.terms_url,
    privacy_url = excluded.privacy_url,
    content_policy_url = excluded.content_policy_url;

  if (select count(*) from public.legal_versions where is_current) <> 1
     or not exists (
       select 1 from public.legal_versions
       where version = '2026-09-07'
         and privacy_url = 'https://www.itala.fyi/archive/2026-09-07/privacy/'
     )
     or not exists (
       select 1 from public.legal_versions
       where version = '2026-10-02'
         and privacy_url = 'https://www.itala.fyi/privacy/'
     ) then
    raise exception 'Legal version staging did not reach the expected state';
  end if;
end $$;
