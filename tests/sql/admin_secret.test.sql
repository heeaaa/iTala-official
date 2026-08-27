-- @requires: admin
--
-- Admin password storage and the elevate_to_admin RPC.
--
-- What matters here is not "is the password strong". It is that the RPC is
-- granted to `anon`, and the anon key is inlined into the JS bundle by Metro and
-- therefore extractable from any installed copy of the app. So the guess rate an
-- attacker gets is whatever the database allows, from anywhere on the internet,
-- with no app involved. These checks pin down that the secret is stored as a
-- hash and that guessing is throttled and locked out.

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- Results go to a table rather than RAISE NOTICE so the runner can read them off
-- stdout deterministically.
create table t_results (n serial primary key, ok boolean, label text, detail text);
create or replace function t_report(label text, cond boolean, detail text default null)
returns void language plpgsql as $$
begin
  -- coalesce: a null condition is a failed check, never a skipped one.
  insert into t_results (ok, label, detail)
  values (coalesce(cond, false), label,
          case when coalesce(cond, false) then null
               else coalesce(detail, case when cond is null then 'condition evaluated to null' end) end);
end $$;

-- A signed-in (anonymous) session, which is what the app boots into.
update auth_state set uid = '11111111-1111-1111-1111-111111111111', anon = true;
insert into profiles (id, is_admin) values ('11111111-1111-1111-1111-111111111111', false)
  on conflict (id) do update set is_admin = false;

-- ---------------------------------------------------------------------------
-- 1) The stored secret must be a hash, not the password.
-- ---------------------------------------------------------------------------
do $$
declare stored text; cols text[];
begin
  select array_agg(column_name::text) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'admin_secret';

  perform t_report('A1 admin_secret has no plaintext `password` column',
                   not ('password' = any(cols)),
                   'columns: ' || array_to_string(cols, ','));

  if 'password_hash' = any(cols) then
    execute 'select password_hash from public.admin_secret where id = 1' into stored;
  elsif 'password' = any(cols) then
    execute 'select password from public.admin_secret where id = 1' into stored;
  end if;

  perform t_report('A2 stored secret is a bcrypt hash',
                   stored is null or stored like '$2%',
                   'stored value begins: ' || left(coalesce(stored, '<null>'), 12));

  -- The value that shipped in the public git history must not still be live.
  perform t_report('A3 the leaked password is not the stored secret',
                   stored is distinct from 'bpblcourtside',
                   'admin_secret still holds the password published in git history');
end $$;

-- ---------------------------------------------------------------------------
-- 2) The seed must not hard-code a real password.
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  -- A schema that ships without a usable admin secret is the safe state: the
  -- password is set once, out of band, after deploy.
  select count(*) into n from public.admin_secret where id = 1;
  perform t_report('B1 schema does not seed a working admin password',
                   n = 0 or (select coalesce(password_hash, '') = '' from public.admin_secret where id = 1),
                   'admin_secret row was seeded by schema.sql');
exception when undefined_column then
  perform t_report('B1 schema does not seed a working admin password', false,
                   'admin_secret still uses a plaintext `password` column');
end $$;

-- ---------------------------------------------------------------------------
-- 3) Guessing must be throttled, and lock out.
-- ---------------------------------------------------------------------------
-- Set a known secret through the supported path so the rest of the suite has
-- something to guess at. set_admin_password is expected to hash it.
do $$
begin
  begin
    perform public.set_admin_password('correct horse battery staple');
  exception when undefined_function then
    -- Pre-fix schema: write the plaintext directly, which is the bug.
    execute $q$ insert into public.admin_secret (id, password) values (1, 'correct horse battery staple')
                on conflict (id) do update set password = excluded.password $q$;
  end;
end $$;

do $$
declare
  i int;
  tries int := 0;   -- separate counter: plpgsql scopes the FOR loop variable to
                    -- the loop, so `i` is null again once the loop exits
  allowed int := 0;
  locked_out boolean := false;
  correct_after_flood boolean;
begin
  -- Hammer it. Every one of these is a call any holder of the shipped anon key
  -- can make, from anywhere, as fast as the network allows.
  for i in 1..200 loop
    tries := i;
    begin
      if public.elevate_to_admin('guess-' || i) then
        allowed := allowed + 1;
      end if;
    exception when others then
      -- A raised exception is a refusal, which is what a lockout looks like.
      locked_out := true;
      exit;
    end;
  end loop;

  perform t_report('C1 no wrong password ever elevates', allowed = 0,
                   allowed || ' wrong guesses were accepted');

  perform t_report('C2 repeated wrong guesses are locked out', locked_out,
                   '200 consecutive wrong guesses were all served with no lockout - '
                   || 'the RPC is an unthrottled online password oracle');

  -- Pin the threshold down, so a lockout that only fires after (say) 10000 tries
  -- cannot pass this suite.
  perform t_report('C2b lockout fires at the configured attempt limit',
                   locked_out and tries <= 10,
                   'lockout took ' || tries || ' attempts');

  -- While locked out, even the CORRECT password must be refused. Otherwise the
  -- lockout is cosmetic.
  begin
    correct_after_flood := public.elevate_to_admin('correct horse battery staple');
  exception when others then
    correct_after_flood := null; -- refused
  end;
  perform t_report('C3 lockout also refuses the correct password',
                   correct_after_flood is not true,
                   'lockout did not apply to a correct attempt');

  perform t_report('C4 the flood did not grant admin',
                   not coalesce((select is_admin from profiles
                                  where id = '11111111-1111-1111-1111-111111111111'), false));
end $$;

-- ---------------------------------------------------------------------------
-- 4) After the lockout window, the correct password still works.
-- ---------------------------------------------------------------------------
do $$
declare ok boolean;
begin
  -- Fast-forward the throttle rather than sleeping.
  begin
    perform public.reset_admin_attempts();
  exception when undefined_function then
    null;
  end;

  begin
    ok := public.elevate_to_admin('correct horse battery staple');
  exception when others then
    ok := false;
  end;

  perform t_report('D1 correct password elevates once the window clears', ok = true);
  perform t_report('D2 profile flag was set',
                   coalesce((select is_admin from profiles
                              where id = '11111111-1111-1111-1111-111111111111'), false));
end $$;

-- ---------------------------------------------------------------------------
-- 5) A signed-out caller can never elevate.
-- ---------------------------------------------------------------------------
do $$
declare ok boolean;
begin
  update auth_state set uid = null;
  begin
    ok := public.elevate_to_admin('correct horse battery staple');
  exception when others then
    ok := false;
  end;
  perform t_report('E1 no session cannot elevate', ok is not true);
  update auth_state set uid = '11111111-1111-1111-1111-111111111111';
end $$;

-- ---------------------------------------------------------------------------
-- 6) An unset password must refuse everything, not wave everybody through.
-- ---------------------------------------------------------------------------
-- This is the state a fresh deploy is in, because schema.sql deliberately seeds
-- no secret. "No password configured" must fail closed.
do $$
declare ok boolean;
begin
  begin perform public.reset_admin_attempts(); exception when undefined_function then null; end;
  -- Clear whichever column this schema version actually has, so a pre-fix schema
  -- still reports a full FAIL table instead of aborting the suite here.
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'admin_secret'
                and column_name = 'password_hash') then
    execute 'update public.admin_secret set password_hash = null where id = 1';
  else
    execute 'delete from public.admin_secret where id = 1';
  end if;
  update profiles set is_admin = false where id = '11111111-1111-1111-1111-111111111111';

  begin ok := public.elevate_to_admin('bpblcourtside'); exception when others then ok := false; end;
  perform t_report('F1 unset password refuses a known guess', ok is not true);

  begin ok := public.elevate_to_admin(''); exception when others then ok := false; end;
  perform t_report('F2 unset password refuses an empty attempt', ok is not true);

  begin ok := public.elevate_to_admin(null); exception when others then ok := false; end;
  perform t_report('F3 unset password refuses a null attempt', ok is not true);

  perform t_report('F4 nobody was granted admin along the way',
                   not coalesce((select is_admin from profiles
                                  where id = '11111111-1111-1111-1111-111111111111'), false));
end $$;

-- ---------------------------------------------------------------------------
-- 7) set_admin_password must not accept a trivially weak secret.
-- ---------------------------------------------------------------------------
do $$
declare rejected boolean := false;
begin
  begin
    perform public.set_admin_password('short');
  exception
    when undefined_function then rejected := true; -- pre-fix: no such function
    when others then rejected := true;
  end;
  perform t_report('G1 set_admin_password rejects a very short password', rejected);
end $$;

-- ---------------------------------------------------------------------------
-- report
-- ---------------------------------------------------------------------------
select case when ok then '  PASS  ' else '  FAIL  ' end || label
       || coalesce(' :: ' || detail, '')
  from t_results order by n;
select '  ' || count(*) filter (where ok) || ' passed, '
       || count(*) filter (where not coalesce(ok, false)) || ' failed   [admin_secret]'
  from t_results;
