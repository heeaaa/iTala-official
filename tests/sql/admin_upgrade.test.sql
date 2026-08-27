-- @requires: legacy_admin, admin
--
-- Upgrading an EXISTING project to the hardened admin secret.
--
-- `legacy_admin` recreates the pre-hardening layout (plaintext `password text
-- not null`, seeded), then `admin` loads the current schema.sql section on top -
-- which is exactly what re-running schema.sql in the Supabase SQL Editor does to
-- a live project.
--
-- This path is easy to get wrong and expensive to get wrong. `create table if not
-- exists` does NOT alter an existing table, so without an explicit migration the
-- new `password_hash` column never appears, the seed insert fails, and the
-- functions get replaced anyway - leaving a live project whose elevate_to_admin
-- queries a column that does not exist. Nobody can unlock, and the plaintext is
-- still sitting in the table. schema.sql is documented as safe to re-run, so
-- these checks are what keep that true.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

create table t_results (n serial primary key, ok boolean, label text, detail text);
create or replace function t_report(label text, cond boolean, detail text default null)
returns void language plpgsql as $$
begin
  insert into t_results (ok, label, detail)
  values (coalesce(cond, false), label,
          case when coalesce(cond, false) then null
               else coalesce(detail, case when cond is null then 'condition evaluated to null' end) end);
end $$;

update auth_state set uid = '11111111-1111-1111-1111-111111111111', anon = true;
insert into profiles (id, is_admin) values ('11111111-1111-1111-1111-111111111111', false)
  on conflict (id) do update set is_admin = false;

-- ---------------------------------------------------------------------------
-- 1) The table was migrated in place.
-- ---------------------------------------------------------------------------
do $$
declare cols text[]; stored text;
begin
  select array_agg(column_name::text order by column_name) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'admin_secret';

  perform t_report('U1 plaintext column dropped', not ('password' = any(cols)),
                   'columns: ' || array_to_string(cols, ','));
  perform t_report('U2 password_hash column added', 'password_hash' = any(cols),
                   'columns: ' || array_to_string(cols, ','));
  perform t_report('U3 updated_at column added', 'updated_at' = any(cols));

  select password_hash into stored from public.admin_secret where id = 1;
  perform t_report('U4 the existing password was carried across as a hash',
                   stored like '$2%',
                   'stored: ' || left(coalesce(stored, '<null>'), 12));
  perform t_report('U5 the plaintext value is gone from the row',
                   stored is distinct from 'bpblcourtside');
end $$;

-- ---------------------------------------------------------------------------
-- 2) The same password still works, so nobody is locked out by the upgrade.
-- ---------------------------------------------------------------------------
-- This is the whole point of migrating rather than clearing: an admin who
-- re-runs schema.sql mid-season must not lose their way back in.
do $$
declare ok boolean;
begin
  begin ok := public.elevate_to_admin('bpblcourtside'); exception when others then ok := false; end;
  perform t_report('U6 the pre-upgrade password still unlocks', ok = true);
  perform t_report('U7 profile flag set',
                   coalesce((select is_admin from profiles
                              where id = '11111111-1111-1111-1111-111111111111'), false));
end $$;

do $$
declare ok boolean;
begin
  begin perform public.reset_admin_attempts(); exception when undefined_function then null; end;
  update profiles set is_admin = false where id = '11111111-1111-1111-1111-111111111111';
  begin ok := public.elevate_to_admin('not-the-password'); exception when others then ok := false; end;
  perform t_report('U8 a wrong password is still refused after the upgrade', ok is not true);
end $$;

-- ---------------------------------------------------------------------------
-- 3) Throttling is live on an upgraded project, not just a fresh one.
-- ---------------------------------------------------------------------------
do $$
declare i int; tries int := 0; locked boolean := false;
begin
  begin perform public.reset_admin_attempts(); exception when undefined_function then null; end;
  for i in 1..50 loop
    tries := i;
    begin
      perform public.elevate_to_admin('guess-' || i);
    exception when others then locked := true; exit;
    end;
  end loop;
  perform t_report('U9 lockout applies to an upgraded project', locked and tries <= 10,
                   'lockout after ' || tries || ' attempts');
end $$;

-- ---------------------------------------------------------------------------
-- 4) Re-running the migration again changes nothing (true idempotency).
-- ---------------------------------------------------------------------------
-- The runner already loaded the section once. Loading the same DDL a second time
-- must not drop the hash or resurrect the plaintext column.
do $$
declare before_hash text; after_hash text; cols text[];
begin
  select password_hash into before_hash from public.admin_secret where id = 1;

  -- Re-run just the migration block, the part that is not create-or-replace.
  perform set_config('search_path', 'public, extensions', true);
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='admin_secret'
                    and column_name='password_hash') then
    alter table public.admin_secret add column password_hash text;
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='admin_secret'
                and column_name='password') then
    alter table public.admin_secret drop column password;
  end if;
  insert into public.admin_secret (id, password_hash) values (1, null)
  on conflict (id) do nothing;

  select password_hash into after_hash from public.admin_secret where id = 1;
  select array_agg(column_name::text) into cols from information_schema.columns
   where table_schema='public' and table_name='admin_secret';

  perform t_report('U10 re-running does not clear the stored hash',
                   after_hash is not null and after_hash = before_hash);
  perform t_report('U11 re-running does not resurrect the plaintext column',
                   not ('password' = any(cols)));
end $$;

-- ---------------------------------------------------------------------------
-- report
-- ---------------------------------------------------------------------------
select case when ok then '  PASS  ' else '  FAIL  ' end || label
       || coalesce(' :: ' || detail, '')
  from t_results order by n;
select '  ' || count(*) filter (where ok) || ' passed, '
       || count(*) filter (where not coalesce(ok, false)) || ' failed   [admin_upgrade]'
  from t_results;
