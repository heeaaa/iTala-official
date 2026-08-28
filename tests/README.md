# iTala regression tests

```bash
node tests/run.js        # or: npm test
```

Runs five things: a TypeScript check, a reducer/stats/parser suite, a two-device
sync suite, static structural checks, and database checks against a real Postgres.
Nothing is added to `package.json` dependencies - esbuild is fetched on demand by
`npx`, so the tests need network access the first time.

The database checks skip cleanly when no Postgres is reachable, so `npm test`
works on a laptop with nothing running. To include them, point the standard `PG*`
variables at a server:

```bash
PGHOST=127.0.0.1 PGUSER=postgres npm test
```

A skip is silent by design. That is right on a laptop and wrong in CI, where a
job that lost its database would still report success having verified nothing.
Set `ITALA_REQUIRE_DB=1` to turn both "no psql" and "no server" into hard
failures. The CI workflow sets it, so the database suites are mandatory there.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and every push to `main`:

- **lint** - `npm ci`, then `npm run lint`. Its own job rather than a step inside
  `verify`, so a lint failure reports in about a minute instead of behind a
  Postgres service and the whole regression suite, and a lint failure and a test
  failure are both visible in the same run. `npm run format:check` is
  deliberately **not** wired in yet - see the note below.
- **verify** - `npm ci`, then `node tests/run.js` against a `postgres:16-alpine`
  service with `ITALA_REQUIRE_DB=1`, so the type check, all four JS suites and
  the wired SQL suites must pass. The console output is kept as a `test-output`
  artifact so the pass/fail counts stay auditable after the logs age out.
- **bundle** - `npx expo export --platform android`, which resolves and bundles
  every module through Metro and compiles the result with Hermes. This catches
  broken imports and syntax the type checker never sees. It is not a shippable
  binary: that still needs `eas build` with signing credentials.

A note for Windows contributors: `npm test` runs natively, no workaround needed.
`npx` is a `.cmd` shim that cannot be spawned directly (`ENOENT` when bare,
`EINVAL` as `npx.cmd` on Node 20.12 and later), so the runner resolves npm's own
`npx-cli.js` and runs it under the current `node` binary. `static.test.js`
CHECK 12 stops that regressing.

## Linting and formatting

```text
npm run lint          eslint .            fails on any error
npm run lint:fix      eslint . --fix      auto-fixable subset only
npm run format        prettier --write .  NOT yet applied repo-wide
npm run format:check  prettier --check .  currently reports 54 files
```

`eslint.config.js` builds on `eslint-config-expo` 10.x, which is the SDK 54-era
release - later versions renumbered to track SDK numbers, so 55.x and above pull
the plugin set for a different SDK. `eslint-config-prettier` is applied last so
ESLint never argues with Prettier about the same line.

Two rules are set deliberately, both explained inline in the config:

- `react/no-unescaped-entities` is **off**. It stops a bare apostrophe breaking
  HTML parsing; RN's `<Text>` renders string children literally, so escaping
  would render a literal `&apos;` to the user.
- `react-hooks/exhaustive-deps` is a **warning**, not an error. Its only two hits
  are CODE_REVIEW.md F-14, and changing a dependency array changes when a memo
  recomputes - a behaviour change that needs its own tests. It stays visible on
  every run until F-14 lands.

Everything else that fired on the first run was fixed rather than suppressed, so
the gate starts from zero errors. **Prettier is configured but not applied**: it
would reformat all 54 files, so that belongs in its own mechanical commit. When
someone does it, re-verify the CHECK blocks afterwards - several match exact
source strings, so a reformat can make a check vacuous without failing it.

CHECK 16 guards that the config, the `lint` script and the CI step all still
exist, and that unused symbols stay an error rather than drifting to a warning.

### Validating the lockfile against CI's npm, not yours

CI's first step in all three jobs is `npm ci`, and **`npm ci` is stricter than
`npm install` and disagrees between npm majors.** Adding the lint dependencies
produced a `package-lock.json` that npm 11 accepted and npm 10 rejected:

```text
npm error Missing: @emnapi/core@1.11.3 from lock file
npm error Missing: @emnapi/runtime@1.11.3 from lock file
```

npm 11 recorded those only as nested entries under
`@unrs/resolver-binding-wasm32-wasi` (reached via `eslint-config-expo` ->
`eslint-import-resolver-typescript` -> `unrs-resolver`); npm 10 wants the hoisted
copies too. `npm ci --dry-run` passed locally and all three CI jobs still failed.

`node-version: '20'` in the workflow means CI runs **npm 10**. So after any
dependency change, validate with that major rather than whatever is on your PATH:

```bash
npx npm@10 ci --dry-run     # what CI actually runs
npm ci --dry-run            # your local npm
```

Both must exit 0. Regenerating with `npx npm@10 install` produces a lockfile that
satisfies both, because npm 10 records the superset.

## What is covered

**Reducer and stats (`reducer.test.js`)** - every state transition that matters:
league/team/player lifecycle, bulk roster import, drop-in game setup, cleanup
(including the rule that a team shared with a surviving game must not be
deleted), lineups and substitutions, undo/redo, the stats engine (points from
mixed makes, box scores, standings, career stats, foul-outs, awards), and the
roster parser against a deliberately messy real-world paste. Also asserts
immutability and that unknown ids never throw.

**Two-device sync (`sync.test.js`)** - the suite the undo bug needed. The reducer
suite proves what an action does LOCALLY; this one proves what it does on the
SERVER, and what the other device sees afterwards. It drives the real reducer, the
real `pushAction`/`fetchAllState`, and the real dispatch-side primitives
(`resolveUndoTarget`, `enqueuePush`, the undo tombstone guard) against a PostgREST
emulator in `harness/fakeSupabase.js`.

The emulator models the two server behaviours a naive stub hides, both of which
were live undo bugs:

- **per-operation latency**, so a test can make a DELETE overtake the INSERT it
  is undoing - which is what "tap a stat, undo it immediately" produces on a
  flaky connection, and which used to leave the row alive on the server
- **RLS as a silent filter**, because PostgREST does not error when row-level
  security hides the rows a DELETE targeted; it succeeds having removed nothing.
  A client that does not ask for the deleted rows back cannot tell the difference

Covered: an undone stat never survives on the server or comes back on a pull;
redo round-trips; a refetch already in flight when the undo happens cannot
resurrect it; a refused delete surfaces as a sync error instead of a false
"saved"; undoing a foul-out restores the court on both devices; and two devices
converge on an ordinary sequence of stats and undos.

**Static checks (`static.test.js`)** - invariants that catch whole bug classes:

- every route in `RootStackParams` has a `<Stack.Screen>` and vice versa
  (this is the check that would have caught the dead "Finish Game" button)
- every `navigation.navigate('X')` target is a declared route
- every action in the `Action` union is handled by the reducer, and persisted by
  the sync layer unless it is deliberately local-only
- every `sb.rpc('name')` the client calls exists in `schema.sql`
- every `.from('table')` the client touches exists in `schema.sql`
- no non-null assertions on `.find()` (a missing row would crash the screen)
- `app.json` still has the EAS `projectId`, does **not** declare `RECORD_AUDIO`
  (nothing records audio, and an unused Android permission cannot be honestly
  declared on Google Play's Data safety form), and
  `DEPLOYMENT.md` still has the zip-apply commands
- the sync primitives stay wired into `dispatch` - pushes go through
  `enqueuePush`, undo resolves its target id and tombstones it, `HYDRATE` drops
  tombstoned events, and the undo delete asks for the deleted rows back. The sync
  suite builds its own dispatch glue, so these checks are what stop it passing
  while the app has quietly stopped calling them
- no hard-coded password literal in the schema, the client, or the docs; the
  schema stores a hash, seeds no usable secret, and throttles attempts
- CI actually verifies pull requests: a workflow runs `tests/run.js` on
  `pull_request` with `ITALA_REQUIRE_DB=1`, and another runs `npm run lint`
  (CHECK 13 and CHECK 16). A config nothing executes prevents nothing.
- the accessibility semantics of the live stat flow and the shared `ui.tsx`
  primitives are still declared (CHECK 14) - structural only, it cannot prove a
  screen reader reads them sensibly
- the privacy policy still covers what the store declarations depend on
  (CHECK 15) - presence checks on prose, so they stop a section vanishing but
  cannot stop it becoming wrong

Warnings are reported separately from failures. The positional-lookup warnings
in `sync.ts` are known and currently safe, because `pushAction` receives the
post-dispatch state for that one action, so "the last row" is that action's own
row. They are flagged because the pattern is fragile, not because it is broken.

## Database checks (`tests/sql/`)

The SQL in `supabase/schema.sql` is exercised against a real Postgres, no Supabase
project needed. `tests/sql/run.js` creates a throwaway database per suite, loads
`harness.sql` (auth stubs + table shapes + helpers), then loads only the section of
`schema.sql` that suite declares with a `-- @requires:` marker - so the assertions
run against the shipped SQL rather than a copy of it.

```bash
PGHOST=127.0.0.1 PGUSER=postgres node tests/sql/run.js               # all wired suites
PGHOST=127.0.0.1 PGUSER=postgres node tests/sql/run.js admin_secret  # just one
```

`admin_secret.test.sql` covers the admin password path: the secret is stored as a
bcrypt hash and never seeded by the schema, an unset password refuses everything
(rather than failing open), wrong guesses lock a session out, the lockout also
refuses a correct password while it is active, and a signed-out caller can never
elevate. `elevate_to_admin` has to be callable by `anon` and the anon key ships
inside the app binary, so throttling is the only thing standing between the
function and unlimited remote guessing - that is what these checks defend.

`admin_upgrade.test.sql` covers the other half, which is the expensive half to get
wrong: **re-running `schema.sql` on a project that predates the change.** `create
table if not exists` does not alter an existing table, so without an explicit
migration the new column never appears, the seed insert fails, and the functions
get replaced regardless - leaving a live project whose `elevate_to_admin` queries
a column that does not exist, with the plaintext still in the table. The suite
loads the old layout (`legacy_admin`) then the current one on top and asserts the
plaintext column is dropped, the existing password is carried across as a hash so
nobody is locked out, throttling is live, and a second re-run is a no-op.

`settings_backfill.test.sql` and `settings_backfill_fresh.test.sql` cover removing
the app-wide `trackMisses` toggle. Stat tracking is per-league now
(`leagues.track_misses`), with a per-game override for drop-in games; the old
global lived in an `app_settings` key/value row and is gone. A null
`track_misses` means "row predates the column", so the migration has to carry the
old global onto those rows *before* dropping the table - otherwise a project
whose global was `false` silently gets miss tracking switched back on for every
pre-migration league. The first suite asserts the value carries across and that an
explicitly-set league is never overwritten; the second runs the same migration with
no `app_settings` table at all, which is both a fresh install and every re-run of
`schema.sql`, and is what the `to_regclass` guard exists for.

The client half of the same migration is covered by GROUP N in
`reducer.test.js`: a device upgrading from an older build still has the global in
its saved state, and `HYDRATE` reads it once to seed leagues that predate the
column.

The remaining suites have no `@requires` marker yet and are **skipped** by the
runner, which reports them as manual: run without their RPC sections loaded they
would query empty tables and pass without asserting anything. Run them by hand:

```bash
psql -f tests/sql/harness.sql          # auth stubs + table shapes + helpers
# then load the RPCs out of supabase/schema.sql, and:
psql -f tests/sql/rec_setup.test.sql   # community drop-in bundle
psql -f tests/sql/bundles.test.sql     # private ownership, idempotent replay,
                                       # NOT NULL fallbacks, bulk import
psql -f tests/sql/private_rec_ownership.test.sql  # unowned private space is
                                       # claimable; owned space is not hijackable
psql -f tests/sql/community_creator_only.test.sql # community drop-in games are
                                       # scoreable only by their creator or a
                                       # Super Admin; other leagues unchanged
```

`harness.sql` stubs `auth.uid()` / `auth.jwt()` and recreates the table shapes,
so it verifies the function logic - not the real RLS policies, which still need
a live project.

## Not covered

Rendering, navigation, gestures, native modules (share-card capture, haptics,
image picker) and real Supabase/RLS behaviour. Those need a device or a build.
