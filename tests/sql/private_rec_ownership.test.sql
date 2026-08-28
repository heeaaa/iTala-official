-- @requires: is_admin, games_created_by, authz, rec_setup
--
-- Claiming a PRIVATE drop-in space that has no owner.
--
-- The scenario is a real one, not hypothetical: an earlier attempt created the
-- `leagues` row and then failed before writing the membership row. The space now
-- exists, belongs to nobody, and `can_score` returns false for its own creator -
-- so every subsequent write is rejected and the user is permanently locked out of
-- a league only they can see. rec_setup_game therefore claims an UNOWNED private
-- space on any call, not just the call that created it.
--
-- The other half is the security half, and it is why "claim it whenever unowned"
-- has to mean *unowned*: a second user must not be able to take a space that is
-- already owned.
--
-- Section order is load order: `authz` defines can_score_game, whose body reads
-- games.created_by, so `games_created_by` must load first.

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

-- The orphan: a private drop-in league with no membership row, and the current
-- user is not an admin.
insert into public.leagues values
  ('rec-u1','Private Drop-In Games','Drop-In','recreational',null,true,true,false,false,false,1720000000000);

do $$
begin
  perform t_report('P1 the orphaned private space starts unowned and unscoreable',
                   public.is_admin() is false
                     and public.member_role('rec-u1') is null
                     and public.can_score('rec-u1') is false,
                   'is_admin=' || coalesce(public.is_admin()::text,'null')
                     || ' member_role=' || coalesce(public.member_role('rec-u1'),'(none)')
                     || ' can_score=' || coalesce(public.can_score('rec-u1')::text,'null'));
end $$;

-- Exactly what the app does next.
select public.rec_setup_game('rec-u1','Private Drop-In Games', false, 1720000000000,
  'gP','Court', true, true,
  '[{"id":"tP1","name":"Reds","color":"#FF4D4F","players":[{"id":"pP1","name":"A","number":"1"}]},
    {"id":"tP2","name":"Blues","color":"#12D7D0","players":[{"id":"pP2","name":"B","number":"2"}]}]'::jsonb);

do $$
begin
  perform t_report('P2 the caller claims the unowned space as owner',
                   public.member_role('rec-u1') = 'owner',
                   'member_role=' || coalesce(public.member_role('rec-u1'),'(none)')
                     || ' - an orphaned row would otherwise lock its own creator out');
end $$;

do $$
declare t int; g int;
begin
  select count(*) into t from public.teams where league_id = 'rec-u1';
  select count(*) into g from public.games where id = 'gP';
  perform t_report('P3 teams and the game were written once ownership was claimed',
                   t = 2 and g = 1, 'teams=' || t || ' games=' || g);
end $$;

do $$
declare c int;
begin
  select count(*) into c from public.league_members where league_id = 'rec-u1' and role = 'owner';
  perform t_report('P4 exactly one owner', c = 1, 'found ' || c);
end $$;

-- Security: a DIFFERENT user must not be able to claim an already-owned space.
-- rec_setup_game should reach its can_score check and raise.
update auth_state set uid = '22222222-2222-2222-2222-222222222222', anon = false;
do $$
declare raised boolean := false; err text;
begin
  begin
    perform public.rec_setup_game('rec-u1','Private Drop-In Games', false, 1720000000000,
      'gX','Court', true, true,
      '[{"id":"tX1","name":"X","color":"#fff","players":[]},
        {"id":"tX2","name":"Y","color":"#000","players":[]}]'::jsonb);
  exception when others then
    raised := true; err := SQLERRM;
  end;
  perform t_report('P5 a second user is refused an already-owned private space',
                   raised,
                   'rec_setup_game returned successfully - it must raise for a non-member');
  perform t_report('P6 the refusal is the scorekeeper check, not an incidental error',
                   raised and err like '%Scorekeeper access required%',
                   'got ' || coalesce(quote_literal(err), 'no error'));
end $$;

do $$
declare c int;
begin
  select count(*) into c from public.league_members where league_id = 'rec-u1';
  perform t_report('P7 the membership table still has exactly one row', c = 1,
                   'found ' || c || ' - a second claim must not add an owner');
end $$;

-- The refused call must not have left anything behind.
do $$
declare g int; t int;
begin
  select count(*) into g from public.games where id = 'gX';
  select count(*) into t from public.teams where id in ('tX1','tX2');
  perform t_report('P8 the refused call wrote no game and no teams',
                   g = 0 and t = 0, 'games=' || g || ' teams=' || t);
end $$;

update auth_state set uid = '11111111-1111-1111-1111-111111111111', anon = false;

-- report
select case when ok then '  PASS  ' else '  FAIL  ' end || label
       || coalesce(' :: ' || detail, '')
  from t_results order by n;
select '  ' || count(*) filter (where ok) || ' passed, '
       || count(*) filter (where not coalesce(ok, false)) || ' failed   [private_rec_ownership]'
  from t_results;
