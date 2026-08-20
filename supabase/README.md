# Supabase

The database is the security boundary. Everything in `migrations/` is version
controlled and applied in filename order; nothing is ever edited by hand in the
dashboard, because v1 could not answer "has production drifted?" and this one
must be able to.

## Applying the schema

**Option A, the one-paste path.** Open the SQL editor in your project and run
[`apply-all.sql`](apply-all.sql). It is every migration concatenated in order,
and it is safe to re-run.

**Option B, the Supabase CLI.**

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Then, on the project itself, do the one thing no migration can do for you:

**Authentication -> Providers -> Anonymous: enable it.**

Without anonymous sign-in nothing works, and the failure is silent rather than
loud: the initial read runs unauthenticated, row-level security returns an
empty array with no error, and every device looks like it has lost all its
data. This cost v1 real debugging time.

## Setting the admin password

The password lives **only** in the database, only as a bcrypt hash, and appears
nowhere in this repository. Run this once in the SQL editor, replacing the
placeholder with the real value:

```sql
insert into public.admin_secret (id, password_hash)
values (1, extensions.crypt('PUT THE PASSWORD HERE', extensions.gen_salt('bf', 12)))
on conflict (id) do update
  set password_hash = excluded.password_hash,
      updated_at    = now();
```

Notes:

- Rotating the password later is the same statement again. There is no code
  change and no app release, which was the whole point of moving it here.
- Once hashed it cannot be read back. Keep it somewhere you control.
- Do not paste the real value into a commit, an issue, a chat message or this
  file. If it ever leaks, run the statement again with a new value.
- Until this is set, `elevate_to_admin` fails closed with
  `{"ok": false, "reason": "not_configured"}` rather than letting anyone in.

## What the schema gives you

| Object                                       | Purpose                                                                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `profiles`                                   | One row per auth user. `is_admin` is the whole authorisation model. No write policy, so no client can set it.                                                                                                            |
| `admin_secret`                               | Singleton, bcrypt hash. RLS on with **zero policies**, so it is unreachable through the API. That empty policy set is deliberate.                                                                                        |
| `admin_attempts`                             | Per-caller failure counter. Five wrong guesses in fifteen minutes buys a fifteen minute lockout.                                                                                                                         |
| `leagues` `teams` `players` `games` `events` | The domain. Real foreign keys throughout.                                                                                                                                                                                |
| `can_write(league_id)`                       | The only predicate any write policy calls. Today it asks one global question; when invite-code accounts ship it consults a memberships table and every policy starts enforcing per-league roles without being rewritten. |
| `elevate_to_admin(text)`                     | Password check plus elevation. Returns jsonb so the client can tell "wrong password" from "locked out" from "not configured".                                                                                            |
| `lock_admin()`                               | Drops the caller back to spectator.                                                                                                                                                                                      |
| `ping()`                                     | Exists so the keep-alive job can stop a free-tier project auto-pausing.                                                                                                                                                  |

## Verifying a change

Never paste an edited migration into a real project without running this first:

```bash
bash supabase/tests/run.sh
```

It creates a throwaway database, applies every migration, and asserts twenty
behaviours: that an unauthenticated caller reads nothing, that a signed-in
spectator cannot write, that `admin_secret` is unreadable, that five wrong
guesses lock the caller out and the lockout holds even against the correct
password, that the dropped legacy event types are rejected, and that the
foreign keys v1 lacked actually bite. CI runs the same script on every pull
request.

It needs a local Postgres 16 and superuser access. It creates and drops its own
database and touches nothing else.

## Things that are not in these files

Project settings no migration can capture, which must be reproduced by hand on
any new project:

1. **Anonymous sign-in enabled.** Covered above. This is the one that matters.
2. JWT expiry, SMTP, rate limits, and the project region.
3. Storage buckets for team logos. Those arrive in Phase 5.
