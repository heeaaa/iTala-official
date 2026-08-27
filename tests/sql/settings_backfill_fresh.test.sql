-- @requires: legacy_leagues, settings_backfill
--
-- The two situations where app_settings does NOT exist: a fresh install, and a
-- SECOND run of schema.sql on a project that has already been migrated.
--
-- schema.sql is documented as safe to re-run, and it no longer creates
-- app_settings at all, so the migration block has to cope with the table being
-- absent. Without the to_regclass guard the subquery errors and takes the whole
-- script down - on every fresh project and on every re-run.
--
-- `legacy_leagues` is loaded; `legacy_app_settings` deliberately is not.

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

-- Reaching this point at all is the main assertion. ON_ERROR_STOP is on, so had
-- the migration failed against a missing app_settings the script would already
-- have aborted and the runner would report the suite as errored, not passed.
do $$
begin
  perform t_report('F1 migration runs with no app_settings table present', true);
end $$;

-- With no global to inherit, a pre-migration league takes the documented
-- default rather than being left null.
do $$
declare v boolean;
begin
  select track_misses into v from public.leagues where id = 'lg-pre';
  perform t_report('F2 no global means track_misses defaults to true',
                   v is true, 'got ' || coalesce(v::text, 'null'));
  select track_turnovers into v from public.leagues where id = 'lg-pre';
  perform t_report('F3 no global means track_turnovers defaults to true',
                   v is true, 'got ' || coalesce(v::text, 'null'));
end $$;

-- An already-set value is still not touched on the no-table path.
do $$
declare v boolean;
begin
  select track_misses into v from public.leagues where id = 'lg-explicit';
  perform t_report('F4 explicit per-league value survives a re-run',
                   v is true, 'got ' || coalesce(v::text, 'null'));
end $$;

do $$
declare n int;
begin
  select count(*) into n from public.leagues where track_misses is null;
  perform t_report('F5 no track_misses nulls remain', n = 0, n || ' row(s) still null');
end $$;

-- report
select case when ok then '  PASS  ' else '  FAIL  ' end || label
       || coalesce(' :: ' || detail, '')
  from t_results order by n;
select '  ' || count(*) filter (where ok) || ' passed, '
       || count(*) filter (where not coalesce(ok, false)) || ' failed   [settings_backfill_fresh]'
  from t_results;
