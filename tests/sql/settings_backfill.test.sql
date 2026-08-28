-- @requires: legacy_leagues, legacy_app_settings, settings_backfill
--
-- Upgrading an EXISTING project off the app-wide trackMisses toggle.
--
-- `legacy_leagues` writes rows as they look on a project that predates
-- leagues.track_misses (nulls), `legacy_app_settings` recreates the old
-- key/value table with a global set to FALSE, and `settings_backfill` then runs
-- the migration block out of schema.sql on top - which is exactly what
-- re-running schema.sql in the Supabase SQL Editor does to a live project.
--
-- The expensive mistake this guards against: dropping app_settings and letting
-- the nulls fall back to `true` would silently switch miss tracking back ON for
-- every pre-migration league in any project whose global was false. The value
-- has to be carried across BEFORE the table goes, and the statement ordering
-- inside schema.sql is the only thing making that true.

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

-- 1) The legacy global was carried onto the pre-migration league.
do $$
declare v boolean;
begin
  select track_misses into v from public.leagues where id = 'lg-pre';
  perform t_report('B1 pre-migration league inherits the legacy global (false)',
                   v is false, 'got ' || coalesce(v::text, 'null'));
end $$;

-- 2) A league that already had a value keeps it. The column is the source of
--    truth once set; the global must never overwrite it.
do $$
declare v boolean;
begin
  select track_misses into v from public.leagues where id = 'lg-explicit';
  perform t_report('B2 explicit per-league value is not overwritten',
                   v is true, 'got ' || coalesce(v::text, 'null'));
end $$;

-- 3) No nulls survive. A leftover null means the client falls back to its own
--    default, which is the drift this migration exists to remove.
do $$
declare n int;
begin
  select count(*) into n from public.leagues where track_misses is null;
  perform t_report('B3 no track_misses nulls remain', n = 0, n || ' row(s) still null');
  select count(*) into n from public.leagues where track_turnovers is null;
  perform t_report('B4 no track_turnovers nulls remain', n = 0, n || ' row(s) still null');
end $$;

-- 4) track_turnovers never had a global, so it defaults to true rather than
--    picking up the trackMisses value.
do $$
declare v boolean;
begin
  select track_turnovers into v from public.leagues where id = 'lg-pre';
  perform t_report('B5 track_turnovers defaults to true, not to the trackMisses global',
                   v is true, 'got ' || coalesce(v::text, 'null'));
end $$;

-- 5) The legacy table is gone. That is also what makes a re-run safe: the
--    migration's to_regclass guard then takes the no-op path.
do $$
begin
  perform t_report('B6 app_settings table dropped',
                   to_regclass('public.app_settings') is null,
                   'table still present after migration');
end $$;

-- report
select case when ok then '  PASS  ' else '  FAIL  ' end || label
       || coalesce(' :: ' || detail, '')
  from t_results order by n;
select '  ' || count(*) filter (where ok) || ' passed, '
       || count(*) filter (where not coalesce(ok, false)) || ' failed   [settings_backfill]'
  from t_results;
