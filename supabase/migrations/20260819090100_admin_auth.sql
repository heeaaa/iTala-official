-- iTala v2 :: 0002 :: the shared admin secret, hashed and rate limited
--
-- v1 stored this password in plaintext, duplicated it as a hardcoded constant
-- in the client, and granted the checking RPC to `anon` with no rate limiting,
-- no lockout and no attempt logging. The anon key ships inside the app binary,
-- so that RPC was callable by anyone, from anywhere, at any rate. A short
-- shared secret was trivially brute-forceable.
--
-- v2: bcrypt, database only, with lockout. The plaintext exists nowhere in
-- this repository. See supabase/README.md for how to set it.

-- ---------------------------------------------------------------------------
-- admin_secret: a singleton table with RLS ON and ZERO POLICIES.
--
-- In Postgres, RLS enabled with no policies means no API caller can read or
-- write it at all. Only security-definer functions running as the table owner
-- can touch it. That empty policy set is intentional; do not "fix" it.
-- ---------------------------------------------------------------------------
create table if not exists public.admin_secret (
  id            int primary key default 1 check (id = 1),
  password_hash text not null,
  updated_at    timestamptz not null default now()
);

alter table public.admin_secret enable row level security;
revoke all on public.admin_secret from anon, authenticated;

-- ---------------------------------------------------------------------------
-- admin_attempts: per-caller failure counter driving lockout. Also RLS on,
-- zero policies, for the same reason.
-- ---------------------------------------------------------------------------
create table if not exists public.admin_attempts (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  failed_count    int not null default 0,
  window_started  timestamptz,
  locked_until    timestamptz,
  last_attempt_at timestamptz not null default now()
);

alter table public.admin_attempts enable row level security;
revoke all on public.admin_attempts from anon, authenticated;

-- Tunables. Five wrong guesses inside fifteen minutes buys a fifteen minute
-- lockout, which turns an online brute force into something that would take
-- longer than the heat death of a basketball season.
create or replace function public.admin_max_attempts() returns int
  language sql immutable as $$ select 5 $$;
create or replace function public.admin_window() returns interval
  language sql immutable as $$ select interval '15 minutes' $$;
create or replace function public.admin_lockout() returns interval
  language sql immutable as $$ select interval '15 minutes' $$;

-- ---------------------------------------------------------------------------
-- elevate_to_admin(): check the shared password and, on success, mark this
-- caller admin.
--
-- Returns jsonb rather than v1's bare boolean so the client can distinguish
-- "wrong password" from "locked out" from "no session" and say something
-- useful. A wrong password is still HTTP 200; it is a successful call that
-- reports failure.
-- ---------------------------------------------------------------------------
create or replace function public.elevate_to_admin(password_attempt text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid     uuid := auth.uid();
  v_row     public.admin_attempts%rowtype;
  v_hash    text;
  v_ok      boolean;
  v_now     timestamptz := now();
  v_remain  int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'no_session');
  end if;

  insert into public.admin_attempts (user_id) values (v_uid)
  on conflict (user_id) do nothing;

  select * into v_row from public.admin_attempts where user_id = v_uid for update;

  -- Locked out. Report how long is left rather than silently failing.
  if v_row.locked_until is not null and v_row.locked_until > v_now then
    return jsonb_build_object(
      'ok', false,
      'reason', 'locked',
      'retry_after_seconds', ceil(extract(epoch from (v_row.locked_until - v_now)))::int
    );
  end if;

  -- The failure window has expired, so start counting again.
  if v_row.window_started is null or v_row.window_started < v_now - public.admin_window() then
    update public.admin_attempts
       set failed_count = 0, window_started = v_now, locked_until = null
     where user_id = v_uid;
    v_row.failed_count := 0;
  end if;

  select password_hash into v_hash from public.admin_secret where id = 1;
  if v_hash is null then
    -- No password has been set on this project yet. Fail closed, loudly.
    return jsonb_build_object('ok', false, 'reason', 'not_configured');
  end if;

  v_ok := (v_hash = extensions.crypt(password_attempt, v_hash));

  if v_ok then
    update public.admin_attempts
       set failed_count = 0, window_started = null, locked_until = null, last_attempt_at = v_now
     where user_id = v_uid;
    update public.profiles set is_admin = true where id = v_uid;
    return jsonb_build_object('ok', true);
  end if;

  update public.admin_attempts
     set failed_count    = v_row.failed_count + 1,
         window_started  = coalesce(window_started, v_now),
         last_attempt_at = v_now,
         locked_until    = case
           when v_row.failed_count + 1 >= public.admin_max_attempts()
           then v_now + public.admin_lockout()
           else null
         end
   where user_id = v_uid
   returning failed_count into v_row.failed_count;

  if v_row.failed_count >= public.admin_max_attempts() then
    return jsonb_build_object(
      'ok', false,
      'reason', 'locked',
      'retry_after_seconds', ceil(extract(epoch from public.admin_lockout()))::int
    );
  end if;

  v_remain := public.admin_max_attempts() - v_row.failed_count;
  return jsonb_build_object('ok', false, 'reason', 'wrong_password', 'attempts_remaining', v_remain);
end;
$$;

-- ---------------------------------------------------------------------------
-- lock_admin(): drop back to spectator on this device.
-- ---------------------------------------------------------------------------
create or replace function public.lock_admin()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  update public.profiles set is_admin = false where id = auth.uid();
end;
$$;

grant execute on function public.elevate_to_admin(text) to anon, authenticated;
grant execute on function public.lock_admin() to anon, authenticated;

-- The tunables and the hash itself are never callable from the API.
revoke execute on function public.admin_max_attempts() from anon, authenticated;
revoke execute on function public.admin_window() from anon, authenticated;
revoke execute on function public.admin_lockout() from anon, authenticated;
