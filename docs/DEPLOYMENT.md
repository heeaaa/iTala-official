# Deployment and operations

Everything here is reproducible from this repository plus a handful of project
settings that no file can capture. Those settings are listed explicitly rather
than left to be rediscovered.

## Environments

There is one Supabase project and no staging environment. That is a deliberate
choice for a zero-budget, pre-launch app, and it is worth writing down so
nobody assumes otherwise. `bash supabase/tests/run.sh` is what stands in for a
staging database: schema changes are proven against a throwaway Postgres before
they touch the real one.

## Standing up the backend

1. Create a free-tier Supabase project. **The region is irreversible without a
   migration.** This project is in `us-east-1` (North Virginia) because the
   users are mainly in British Columbia.
2. Apply the schema: see [`supabase/README.md`](../supabase/README.md).
3. **Authentication -> Providers -> Anonymous: enable it.** Nothing works
   without this, and it fails silently rather than loudly.
4. Set the admin password with the SQL snippet in `supabase/README.md`. It is
   not in any file here, deliberately.

## Environment variables

| Name                            | Where                 | Purpose                              | Consequence if missing                                               |
| ------------------------------- | --------------------- | ------------------------------------ | -------------------------------------------------------------------- |
| `EXPO_PUBLIC_SUPABASE_URL`      | app build             | Project URL, inlined into the bundle | The app runs local-only: no sync, no spectators, no realtime         |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | app build             | Anon JWT, inlined into the bundle    | As above. Both are required together                                 |
| `SUPABASE_URL`                  | GitHub Actions secret | Keep-alive target                    | The keep-alive fails loudly and the project drifts toward auto-pause |
| `SUPABASE_ANON_KEY`             | GitHub Actions secret | Keep-alive auth                      | As above                                                             |

The anon key being public is **by design and is safe**: row-level security is
what protects writes, not key secrecy. The real exposure is that the anon key
is a read credential for every player name in the database, which is why the
privacy policy has to be accurate. It is not a secret to be guarded; it is a
public identifier to be honest about.

Local development uses a gitignored `.env`. `.env.example` carries the blanks.
For real builds, inject them as EAS secrets rather than committing them:

```bash
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_URL --value 'https://<ref>.supabase.co'
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value '<anon key>'
```

## The keep-alive job

Free-tier Supabase projects pause after **7 consecutive idle days**. A league
that plays once a week will trip that between game days, and the failure is the
worst kind: every device silently falls back to local-only behaviour, reads
fail, writes are dropped, and nobody is told.

`.github/workflows/supabase-keepalive.yml` prevents it by calling the `ping()`
function every 3 days at 09:00 UTC.

**Setting it up on a new repository:**

1. Settings -> Secrets and variables -> Actions -> New repository secret.
2. Add `SUPABASE_URL`, for example `https://<project-ref>.supabase.co`. No
   trailing slash.
3. Add `SUPABASE_ANON_KEY`.
4. Actions -> "Supabase keep-alive ping" -> **Run workflow**. Do not wait three
   days to find out whether it works.

**Confirming it worked.** The run log prints `HTTP 200 - body: "2026-..."`
followed by `Project is awake.` Anything else fails the job with an
annotation.

**When it fails, in order of likelihood:**

| Symptom                                                    | Cause                                | Fix                                        |
| ---------------------------------------------------------- | ------------------------------------ | ------------------------------------------ |
| `Set the SUPABASE_URL and SUPABASE_ANON_KEY secrets first` | Secrets missing or named wrong       | Add them, exact names                      |
| HTTP 404                                                   | `ping()` is missing from the project | Re-apply `supabase/apply-all.sql`          |
| HTTP 401                                                   | Anon key rotated or wrong            | Copy the current one from Settings -> API  |
| HTTP 503, or a timeout                                     | The project is already paused        | Restore it from the dashboard, then re-run |

GitHub also disables scheduled workflows on repositories with no activity for
60 days. If nobody has pushed in two months, check the Actions tab is still
enabled. A calendar reminder is cheaper than a paused database discovered on a
game day.

An external uptime monitor pointed at the same endpoint, weekly or more often,
is a reasonable belt-and-braces alternative. If you set one up, note it here so
that retiring the endpoint later does not leave an orphan alerting forever.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request:

- `pnpm verify`: format check, lint, typecheck and the domain test suite
- the database job: applies every migration to a throwaway Postgres 16 and
  asserts the twenty security and integrity behaviours in
  `supabase/tests/10_behaviour.sql`

Both are free on a public repository. Neither talks to the real project.

## Mobile builds

Expo SDK 56. **Expo Go is no longer the quick-test path**: Expo Go for SDK 56
is not published on the App Store or Google Play, so the loop is a development
build instead.

That sounds worse than it is, and it means fewer builds rather than more:

```bash
eas build --profile development --platform ios      # once per device
pnpm --filter @itala/mobile start                    # then reload JS as usual
```

A development build behaves exactly like Expo Go for day-to-day work - the
JavaScript reloads over the dev server at the same speed. A **new native build
is only needed when a native dependency changes**, which after Phase 1 is rare.
For everything else, `eas update` pushes JavaScript to testers over the air
with no build at all.

This project is a pnpm workspace, which Metro does not handle by default.
`apps/mobile/metro.config.js` adds the workspace root to `watchFolders` and
points the resolver at both `node_modules` trees. Without it, edits to
`packages/domain` appear to do nothing until the bundler restarts.

`newArchEnabled` is **true**. v1 pinned it to false for Expo Go compatibility,
which is no longer a constraint worth carrying.

## Store submission

Arrives in the release phase. Two things are already known and are worth
recording now so they are not discovered late:

- **Google Play.** Personal developer accounts created after 13/11/2023 must
  run a closed test with at least 12 testers opted in continuously for 14 days
  before applying for production access, and that application is reviewed
  afterwards. Recruiting has to start early, not at the end.
- **Privacy declarations.** v1's runbook instructed declaring "Data Not
  Collected" to Apple on the grounds that the app was offline-only. That
  stopped being true when sync was added. Player names, jersey numbers,
  locations and timestamps are transmitted to and stored on a third-party
  server. Both store declarations must say so.
