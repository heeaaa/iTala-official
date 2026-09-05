# Code Review

> **Current product scope (2026-09-05):** The audit below retains historical wording,
> including broad “offline-first” descriptions. The supported synced workflow now
> documented in the README is online league/roster/game setup, with offline scoring
> during an already-started game and retry after reconnecting. Local-only is a separate
> development configuration. Historical audit descriptions are not a promise of offline
> setup; the administrative replay gap noted under N-40 remains a known limitation.

**Audit date:** 27/08/2026
**Scope:** Full read-only audit of the iTala codebase (Expo/React Native, TypeScript, optional Supabase backend). No application source code was modified as part of this audit.

---

## Executive Summary

iTala is a well-engineered, deliberately-scoped mobile app for offline-first basketball scorekeeping with optional multi-device Supabase sync. The codebase is unusually well-documented for its size: sync races, RLS threat models, and non-obvious invariants are explained in code comments rather than left implicit, and the project maintains its own regression suite (reducer/stats logic, a two-device sync emulator, structural invariant checks, and SQL policy tests) that is more thorough than most projects this size attempt.

**Overall health:** Good foundations, with a small number of serious issues that need prompt attention rather than a systemic quality problem. The core data model (event-sourced box scores, local-first reducer, guarded realtime sync) is sound and its trickiest parts are already covered by tests. The gaps are concentrated in three places: secrets hygiene (one historical, one live), a completely missing CI pipeline, and accessibility of the app's single most important screen (the live two-tap stat tracker).

**Major strengths:**
- Local-first architecture with a single reducer as the source of truth, autosaved on every change, is implemented consistently and defensively (lineup/bundle/undo "guards" against realtime races are well-reasoned and tested).
- Row-level security in `supabase/schema.sql` is thorough, uses `security definer` functions correctly, and the admin-password backup path (bcrypt hash, 5-attempt/15-minute lockout, constant-time comparison) is genuinely well-designed.
- The project's own test suite (138 reducer/stats tests, 32 two-device sync tests, 217 static structural assertions) all pass cleanly when actually run (see Verification Performed below), and the suite catches real bug classes (route/reducer/RPC parity, hard-coded password literals, positional-lookup fragility).
- `lib/stats.ts` is a clean, side-effect-free derivation layer with no React/UI coupling.

**Major weaknesses:**
- A plaintext admin password was committed to git history in the initial commit (now remediated in code, but permanently present in history unless rewritten).
- A file (`bpbl.txt`) tracked in git contains the live production Supabase project URL and anon key, bypassing the project's own `.env` gitignore hygiene.
- There is no CI pipeline that runs tests, linting, type checking, or a build on pull requests; only a Supabase keep-alive ping workflow exists.
- The app's core interaction (the live two-tap stat pad) has no accessibility roles, labels, or live-region announcements anywhere, making it effectively unusable with a screen reader.
- One confirmed data-integrity bug (`DELETE_EVENT` does not reverse a foul-out auto-bench, unlike `UNDO_EVENT`) and one confirmed scoring bug (tied final scores are silently recorded as home-team wins).

**Highest-risk areas:** secrets in git history/tracked files, absence of CI, and the live-scoring screen's accessibility and a small concurrency gap in its substitution modal.

**Immediate priorities:** rotate/confirm rotation of the historical admin password and scrub or accept the git-history exposure; remove `bpbl.txt` and rotate its Supabase anon key; stand up a CI workflow that runs the project's own existing test suite; fix the `DELETE_EVENT` foul-out desync and the tied-score handling; add accessibility roles and live-region announcements to `LiveGameScreen`.

> **Status as of 28/08/2026: every one of those immediate priorities is closed.** Both credentials
> are rotated, the historical exposure is formally accepted (F-01, and it turned out to sit in a
> predecessor repository rather than this one), CI runs on every pull request and is green, and the
> `DELETE_EVENT`, tied-score and accessibility fixes are all merged. See **Remediation Progress**
> below for the current state; the rest of this summary is the original 27/08/2026 audit text.

---

## Application Overview

**Technology stack:** Expo SDK 54, React Native 0.81.5, React 19.1.0, TypeScript 5.9 (strict mode), React Navigation (native-stack), optional Supabase (`@supabase/supabase-js` ^2.45) with AsyncStorage as the local persistence layer.

**Architecture:** A single `useReducer`-based store (`src/store/StoreProvider.tsx`) is the source of truth for all UI state. Every dispatched action is: (1) applied to the reducer immediately (offline-first, always works), (2) autosaved to AsyncStorage on every change (`src/store/storage.ts`), and (3) if Supabase sync is configured (both `EXPO_PUBLIC_SUPABASE_URL`/`EXPO_PUBLIC_SUPABASE_ANON_KEY` env vars set), mirrored to Postgres via `src/sync/sync.ts`'s `pushAction`, serialized through a promise chain (`src/sync/pushQueue.ts`) to preserve dispatch order across the network. A Supabase Realtime subscription triggers a full-state re-pull (`HYDRATE`) when any row changes elsewhere. Because a full re-pull can race a just-made local write, the store protects recent local writes with a pending-writes ledger (`src/sync/pendingEvents.ts`) retired by ORDERING rather than by a clock, a monotonic snapshot watermark that refuses a server snapshot older than one already applied, and a single pull owner so two reads are never on the wire at once. One time-boxed guard remains, `bundleGuard`, for the all-or-nothing drop-in/roster bundles. This is one of the more sophisticated and well-tested parts of the codebase.

**Data model:** Box scores, standings, and leaderboards are never stored directly; they are derived on demand from an append-only `GameEvent` log by `src/lib/stats.ts`. This is a deliberate design choice (documented in `src/types.ts` and `README.md`) that keeps stat corrections (editing/deleting a play) trivially consistent.

**Authentication and authorisation:** Three roles (guest, user, admin), computed in one place (`deriveRole()` in `src/store/AdminProvider.tsx`). In synced mode, guests get an anonymous Supabase session (read-only via RLS); Google/Apple OAuth upgrades to a real account; a hardcoded email allowlist (mirrored in both the client and `supabase/schema.sql`'s `admin_emails` table) grants Super Admin; a hidden password-elevation backup (bcrypt hash, throttled) exists for emergency access. Per-league ownership/scorekeeper roles layer on top via `league_members`, all enforced server-side by RLS, not just client-side gating.

**Persistence:** AsyncStorage locally (`hoops.state.v1`, `hoops.prefs.v1` keys); Postgres via Supabase when configured, with a schema (`supabase/schema.sql`) that is deliberately idempotent (safe to re-run for migrations) and documents its own threat model inline, particularly around the admin-password backup path.

**External services:** Supabase (auth, Postgres, Realtime), Google/Apple OAuth, Expo push/local notifications, `expo-image-picker` for team/promo logos, `expo-view-shot`/`expo-sharing` for share cards (with a documented Expo Go fallback to text-only sharing).

**Testing:** A bespoke, dependency-light regression suite (`tests/`) covering reducer/stats/parser logic, a two-device sync emulator (`tests/harness/fakeSupabase.js`) that models real PostgREST quirks (RLS as a silent filter, per-operation latency causing request reordering), static structural invariants, and SQL-level RLS/RPC tests run against a real (throwaway) Postgres. See Verification Performed and the Testing Assessment below.

**CI/CD:** A single GitHub Actions workflow exists (`.github/workflows/supabase-keepalive.yml`), and it only pings a Supabase RPC every 3 days to prevent free-tier project pausing. No workflow runs tests, linting, type checking, or a build on pushes or pull requests.

---

## Verification Performed

All commands below were actually executed against the repository as it exists on disk; no application source was modified to make anything pass.

```text
npx tsc --noEmit
PASS (clean, no errors)

node tests/reducer.test.js   (reducer / stats / roster-parser suite)
PASS - 138 passed, 0 failed

node tests/sync.test.js      (two-device sync suite against a PostgREST emulator)
PASS - 32 passed, 0 failed

node tests/static.test.js    (structural invariant checks)
PASS - 217 passed, 0 failed, 4 warnings (pre-existing, documented as known/safe
       in tests/README.md - positional array-lookup fragility in src/sync/sync.ts)

node tests/sql/run.js        (schema.sql RLS/RPC tests against a real Postgres)
SKIP - "psql not on PATH - database checks need a Postgres server."
       No local Postgres instance was available in this environment.
```

**Important caveat on how these were run:** the project's own `npm test` entry point (`node tests/run.js`) is currently broken on native Windows. It calls `execFileSync('npx', ...)` without `shell: true`, which throws `ENOENT` on Windows because `npx` is a `.cmd` shim that Node cannot resolve without a shell. This was independently reproduced (`execFileSync('npx', ['--version'])` throws `ENOENT`, code `-4058`) and confirmed to be the root cause. It does **not** affect Linux-based CI runners (e.g. GitHub Actions' `ubuntu-latest`), where `npx` resolves normally - see Finding F-08. To obtain the results above, the same esbuild bundling and test invocations `tests/run.js` performs were run manually via a `cmd.exe /c` wrapper, producing a bundle in a scratch directory outside the repository (deleted afterwards) and executing the unmodified test files (`tests/reducer.test.js`, `tests/sync.test.js`, `tests/static.test.js`) against it exactly as the script would. No repository file was created, modified, or left behind by this process (`git status` before and after this work is identical).

```text
npm audit
24 vulnerabilities reported (1 critical, 14 high, 9 moderate) - all rooted in
Expo/Metro build-tooling transitive dependencies (tar, shell-quote, js-yaml,
nanoid, undici, etc.). These run at build/dev time only and are not bundled
into the shipped app JS. See Finding F-13.

npm outdated / npm ls
Confirmed react 19.1.0 / react-native 0.81.5 / expo ^54.0.0 is a coherent,
currently-supported SDK 54 combination (no version mismatch). All dependencies
are behind "latest" but none are deprecated/abandoned - see Finding F-14.
```

**Not run:**
```text
ESLint / Prettier
NOT RUN - no ESLint or Prettier configuration or dependency exists in the
project at all (see Finding F-09); there is nothing to run.

Native build (EAS build / expo prebuild)
NOT RUN - requires an Apple/Google developer account and EAS credentials not
available in this environment; out of scope for a read-only audit.

UI/component/E2E tests, on-device accessibility testing (VoiceOver/TalkBack)
NOT RUN - no device/simulator/emulator available in this environment; the
project itself has no automated tests at this level (see Testing Assessment).
Accessibility findings below are from code inspection, not on-device testing.

SQL suite (tests/sql/)
SKIP (see above) - no local Postgres server available.
```

---

## Remediation Progress

**Progress last updated:** 04/09/2026 (N-40 id divergence between the two reducer runs raised and fixed; N-39 truncated snapshot deleting live stats raised and fixed; N-38 offline/connectivity bugs raised and fixed; N-37 change request; N-32 to N-36 raised and fixed; N-19 to N-31 before that). Original audit: 27/08/2026.

Status values used in the Findings Summary below:

| Status | Means |
|---|---|
| `FIXED (merged)` | On `main`. Done. |
| `NOT A DEFECT` | Investigated and the reported behaviour does not occur; the property is now pinned by a test. Used once, for F-27. |
| `FIXED (risk accepted)` | Closed by a recorded, dated risk acceptance rather than by further remediation. Used once, for F-01. |
| `FIXED (PR)` | Implemented, pushed, PR open, **not merged**. |
| `PARTIAL` | Partly addressed, or fixed in code but with an unverified step outside the repo. |
| `OPEN` | Not started. |

Counts: **19 fixed** (one of them a recorded risk acceptance), **1 not a defect**, **5 partial**,
**6 open**, 1 informational. **Everything fixed is merged to `main`; nothing is awaiting a PR.**
**All P0 and P1 items are closed.** No CRITICAL or HIGH finding remains open or partial: both
credential rotations are confirmed done (28/08/2026), and the historical exposure behind F-01 is
formally accepted (see below). P2 is largely done: F-09 (ESLint), N-17 (drop-in authorisation suites), F-12 (roster parser),
F-17/F-18 (live-game input safety), and now F-14/F-16/F-28 (live-game performance and lifecycle)
plus F-26/F-29. Of the 6 open findings, 4 are MEDIUM (F-13, F-15, F-19, F-21) and 2 are LOW
(F-23, F-30). **ESLint now reports zero errors and zero warnings**, so
`react-hooks/exhaustive-deps` was promoted to an error - see F-09 and F-14.

> The previous revision of this section read "11 fixed ... 15 open". That was an arithmetic slip,
> not a change in scope - the table has always held 31 numbered findings plus F-32. The counts
> above are generated from the Findings Summary table rather than tallied by hand.

### Branch map

**All work is merged; every remediation branch has been deleted.** Kept as a record of which PR
carried what, because the findings reference each other across them.

Trace any of these with `git log --oneline --merges main`.

| PR | Findings |
|---|---|
| #1 | F-04 |
| #2 | F-03, F-08, N-01, N-02 |
| #3 | F-11, N-03, N-04 |
| #4 | F-05, F-06, F-07 |
| #5 | N-06, and docs for the `person_id` decision |
| #6 | F-22 |
| #7 | F-10, N-05, N-10 |
| #8 | tracker refresh |
| #9 | F-09 (ESLint half), N-07, N-11, N-12, N-13, N-15 |
| #10, #13 | SQL evidence, F-01 risk acceptance, N-17 raised |
| #11 | N-17 (drop-in authorisation suites) |
| #12 | F-12 |
| #14 | F-17, F-18, N-18 |
| #15 | F-14, F-16, F-26, F-28, F-29; F-27 closed as not a defect |
| #16 | privacy policy operator and contact details |

**One process note worth keeping.** The #10 ← #11 ← #12 stack was merged
bottom-first, so #11 and #12 landed in intermediate branches instead of `main` and had to be
re-homed by #14. If a stack is used again, merge it top-down, or squash it into one PR against
`main`.

Stacking cost two incidents worth remembering: **N-10**, where a merge resolution silently dropped
a brace and left a whole test suite unparseable, and the mis-ordered stack above. A merge
resolution is a hand edit that no reviewer diffs as carefully as a code change.

### Resume here

**All P0 and P1 work is closed and merged.** No CRITICAL or HIGH finding is open or partial. What
remains is two things nobody can do from inside this repository, and a quality backlog.

#### Blocking a store submission - not code

1. **Deploy `site/` and paste the URL into both listings.** The policy is written and filled in;
   steps are in `site/README.md` (Cloudflare Pages: framework preset None, build command empty,
   output directory `site`, production branch `main`). The policy then lives at
   `https://<project>.pages.dev/privacy/`. Both listings need it. The two contact mailboxes are
   load-bearing - they are how someone who never installed the app gets their name removed, and the
   policy promises a reply within 20 working days - so they have to stay monitored.
2. **Do the on-device screen-reader pass** for F-05/F-06/F-07 (`tests/MANUAL-REGRESSION.md`
   section P6). This is the largest genuinely untested surface in the project. The semantics are in
   place and CHECK 14 stops them being deleted, but no real screen reader has read them, and a
   structural check cannot tell you whether what it reads out makes sense.

#### Quality backlog, in the order I would take it

3. **N-16 - CI runs an unsupported Node.** `node-version: '20'` left maintenance LTS in April 2026,
   and its bundled npm 10 already caused one red build (N-15). SDK 54 supports Node 22. One line,
   and it is the runner every other verification depends on, so it goes first.
4. **F-21 - touch targets.** Accessibility *and* mis-taps, in the same live-game flow F-18 just
   hardened. Those two belong together.
5. **F-15, F-16 follow-ups, F-19** - image resizing, then the duplicated membership-retry logic.
6. **F-13 - `npm audit`.** Needs a deliberate `expo@57` decision, not a blind `npm audit fix`.
   All 24 are build-time only and none reach the shipped bundle, which is why this is not urgent.
7. **F-09's Prettier half - do this last.** It reformats all 54 files, so it will conflict with
   anything in flight. Whoever lands it **must re-verify CHECK 1-18 afterwards**: several match
   exact source strings, so a reformat can make a check vacuous without failing it.

#### Known limitations that are decisions, not debt

- **F-12**: `"Team 2"` as a team header is still read as a player. It is structurally identical to
  `"Pedro Santos 9"`, and this parser's contract is that it never guesses destructively. Asserted
  as O13 so it stays visible.
- **F-27**: closed as NOT A DEFECT. The guards were already there; the audit call was wrong.
- **F-01**: closed by a recorded risk acceptance, not by remediation - the exposure is in a
  predecessor repository that cannot be rewritten from here, and the credential is rotated.

### Environment constraints hit during remediation

Worth knowing before you assume something is broken:

All three constraints the earlier revisions of this document recorded have since been lifted. Kept
because the workarounds are reusable, and because two of them caused real incidents.

- **The SQL suites run locally now.** There is still no installed Postgres and no Docker, so
  `tests/sql/run.js` skips by default. A portable server fixes that with no installer and no admin
  rights: download the EnterpriseDB *binaries-only* zip
  (`postgresql-17.6-1-windows-x64-binaries.zip`, not the installer), `initdb`, and start it from a
  batch file that puts `pgsql\bin` on `PATH` **first** - without that the forked backend dies with
  `exception 0xC0000142`, a DLL-init failure, even though `initdb` itself succeeded. Then run with
  `PGPORT=55432 ITALA_REQUIRE_DB=1`. This is what made converting the four skipped authorisation
  suites (N-17) practical: verifying SQL through CI alone is a multi-minute loop per iteration.
- **The `C:` drive was full** during the first pass (0 bytes free at one point), which is why an
  earlier revision recorded no local bundle verification. Space was freed and
  `npx expo export --platform android` has completed cleanly on every subsequent branch.
- **`gh` is installed and authenticated** (2.98.0, as of 29/08/2026), and the repository is now
  public. CI results and the per-suite counts in the `test-output` artifact can be read first-hand
  with `gh pr checks` and `gh run download`, which is what the "never claim CI passed" rule
  actually needs. Note `gh` is **not** on the default `PATH` here - prepend
  `/c/Program Files/GitHub CLI`. Job logs and artifact downloads need authentication even on a
  public repo, so `gh` is the only route; the unauthenticated REST API returns 403/401 for those.
- **A push to an already-merged branch triggers no CI at all** - not `pull_request` (the PR is
  closed) and not `push` (which fires only for `main`). The push succeeds silently, so the commit
  is stranded and unverified. This happened once and needed a cherry-pick to recover. Check the PR
  state before pushing a follow-up.

### Where the original finding was incomplete or wrong

Four findings turned out to differ from what this audit wrote. Recorded here because the
difference is the useful part.

- **F-10 named the wrong cause.** The finding said `app.json` declares an unused `RECORD_AUDIO`
  permission. Deleting it changed nothing: `expo config` still reported the permission, because
  `expo-image-picker`'s config plugin adds `RECORD_AUDIO` **and** `CAMERA` for video capture unless
  told otherwise. The working fix is `microphonePermission: false` and `cameraPermission: false` on
  the plugin, which both omits them and emits `tools:node="remove"`. Confirmed with
  `expo config --type introspect`.
- **F-11 listed three call sites; there are five.** The same inline `home >= away` was also
  deciding the share card's Player of the Game (`src/lib/cardSpecs.ts`), the box score's share
  layout, and `FinalScoreScreen`'s Player of the Game pool, so a drawn game handed the home team
  the award and hid the away team's best game. There was also a second bug in the same area:
  `TeamProfileScreen` excluded ties from games played while `pf`/`pa` still counted the drawn
  game's points, inflating PPG and OPP PPG. All five now go through one `outcomeOf()` in
  `src/lib/stats.ts`.
- **F-08's recommended fix does not work on current Node.** The finding suggested invoking
  `npx.cmd` explicitly. That fails `EINVAL` on Node 20.12 and later, which refuses to spawn
  `.cmd`/`.bat` without a shell. `shell: true` starts but concatenates argv unescaped (`DEP0190`),
  which mangles the esbuild `--alias` paths for any checkout under a directory containing a space,
  including this one. The runner now resolves npm's own `npx-cli.js` and runs it under
  `process.execPath`.
- **F-22's New Architecture claim is now confirmed, not just likely.**
  `expo config --type introspect` reports `RCTNewArchEnabled: true`. `TROUBLESHOOTING.md` has been
  corrected rather than `app.json` changed, because forcing `newArchEnabled: false` is a runtime
  change that needs device testing, not a documentation edit.

One finding was deliberately not followed literally: F-06 lists `Pill` among the primitives needing
an accessibility role. `Pill` is a static status badge (FINAL/LIVE/SCHEDULED). Giving it
`accessibilityRole="button"` would tell screen-reader users it is actionable when it is not, so it
was left alone. Its text already reads.

### New findings raised during remediation

Not in the original audit. Numbered `N-xx` to keep them distinct from the audit's own `F-xx`.

| ID | Severity | Finding | Status |
|----|----------|---------|--------|
| N-01 | HIGH | `static.test.js` CHECK 5 sliced the `Action` union with `store.indexOf('const defaultSettings')` as its end anchor. Deleting that constant made `indexOf` return `-1`, so `slice(start, -1)` truncated the union and the check kept reporting "pass" while verifying almost nothing. Both boundaries are now anchored explicitly and abort loudly. | FIXED (merged) |
| N-02 | MEDIUM | `tests/sql/run.js` exits 0 when no Postgres answers. Correct for a laptop, wrong for CI: a job that lost its database service would have gone green with zero database coverage. New `ITALA_REQUIRE_DB=1` turns the skip into a failure, and the CI workflow sets it. | FIXED (merged) |
| N-03 | MEDIUM | `TeamProfileScreen` divided points for/against by wins+losses, excluding ties, while `pf`/`pa` still included the drawn game's points. PPG and OPP PPG were inflated. | FIXED (merged) |
| N-04 | MEDIUM | Player of the Game fell back to the home team on a drawn game in both `cardSpecs.ts` and `FinalScoreScreen.tsx`, hiding the away side's best performance entirely. | FIXED (merged) |
| N-05 | MEDIUM | Sponsor promo taps are recorded server-side (`onPromoTap` → `bump_promo_tap`, `update promos set taps = taps + 1`) and were declared on neither store form. Aggregate, no user id, but still advertising-interaction data. | FIXED (merged) |
| N-06 | LOW | The app-wide `trackMisses` setting was dead code: per-league and per-game columns had replaced it, `AppSettings` was marked LEGACY, and `SET_SETTINGS` had no dispatcher anywhere. Removed, with the old global backfilled onto pre-migration leagues first. | FIXED (merged) |
| N-07 | LOW | `tests/run.js` imports `execSync` and never uses it. | FIXED (merged) |
| N-08 | INFO | `src/screens/LiveGameScreen.tsx` uses `[state, leagueId, gameId]` as a `useMemo` dependency, so the box score recomputes on any app-wide state change. This is F-14, confirmed in passing while working in the file. | OPEN (see F-14) |
| N-09 | INFO | `showNextMilestone` in `LiveGameScreen` schedules `setTimeout` with no unmount cleanup. This is F-28, confirmed in passing. | OPEN (see F-28) |
| N-10 | HIGH | Merge `62fb42b` (`main` into `chore/store-compliance-and-privacy-policy`) resolved its only conflict by concatenating both sides of `tests/static.test.js` but dropping the `}` closing CHECK 15 and the `// ---` separator opening CHECK 14. The file stopped parsing (`TS1005`, then `SyntaxError: Unexpected end of input`), so `node tests/run.js` failed twice and **the static suite ran zero checks** - including the CHECK 15 assertions that this very branch added to guard the store declarations and the privacy policy. Fixed forward in `ef766b2`; the resolution was then verified to be the exact union of both parents, not merely parseable. | FIXED (merged) |
| N-11 | HIGH | `EditTeamScreen` calls `useState` **after** an early `return` (`if (!league \|\| !team)`). React identifies hooks by call order, so the hook count changes between renders: mount before the store has the league (it is empty until the first `HYDRATE` lands in synced mode), then re-render once it arrives, and React throws "Rendered more hooks than during the previous render". Reachable by opening the screen on a cold start with sync enabled. Found by `react-hooks/rules-of-hooks` on its first ever run - nothing else in the project could have caught it. | FIXED (merged) |
| N-12 | LOW | `PlayerProfileScreen` defines `Big` and `Avg` twice: as arrow consts inside the component (which shadow, and are what actually renders) and again at module scope. The module-level pair was dead, and its comment claimed they were "used in the on-screen layout" - so editing them changed nothing on screen. Removed; behaviour identical. | FIXED (merged) |
| N-13 | LOW | `tests/run.js` discarded the caught error on a bundling failure and printed a fixed guess about network access, so a syntax error or a bad `--alias` target reported the wrong cause. Now prints `e.message`. | FIXED (merged) |
| N-14 | INFO | `ui.tsx`'s `OnboardingSheet` accepts an `isSignedIn` prop and never reads it, so the first-run copy is identical for guests and signed-in users despite callers passing the flag. Left in the prop type (the sheet is the obvious place to vary that copy) but removed from the destructuring. Latent incomplete feature, not a defect. | OPEN |
| N-15 | HIGH | Adding the F-09 lint dependencies produced a `package-lock.json` that **npm 11 accepted and npm 10 rejected** (`Missing: @emnapi/core@1.11.3 from lock file`). npm 11 recorded those packages only as nested entries under `@unrs/resolver-binding-wasm32-wasi` (`eslint-config-expo` -> `eslint-import-resolver-typescript` -> `unrs-resolver`); npm 10 also wants the hoisted copies. `node-version: '20'` means CI runs npm 10, so **all three CI jobs failed at `npm ci`** while `npm ci --dry-run` passed locally on npm 11 - a false green. Regenerated with `npx npm@10 install`, which records the superset, and verified under both majors. No direct dependency version changed. | FIXED (merged) |
| N-16 | MEDIUM | `.github/workflows/ci.yml` pins `node-version: '20'`. Node 20 left maintenance LTS in April 2026, so CI verifies every pull request against an unsupported runtime, and its bundled npm 10 is what caused N-15. Expo SDK 54 supports Node 20 and 22. Not changed as part of F-09: moving the version changes what CI verifies against and deserves its own PR and its own green run, rather than being bundled into a lint change. | OPEN |
| N-17 | MEDIUM | ~~Four of the eight SQL suites never ran in CI.~~ **FIXED.** They were the drop-in-game authorisation tests - `rec_setup_game`, `can_score_game`, `member_role`, `can_score`, `is_admin`, `bulk_import_roster` - and carried no `-- @requires:` marker, so the runner skipped them: the layer deciding who may score a game had no automated verification at all. They were also diagnostic `select 'label', value` scripts rather than asserting suites, so a marker alone would not have been enough. All eight now run, and SQL coverage went 39 -> 81 assertions. Needed five new sliceable `schema.sql` sections (`is_admin`, `authz`, `games_created_by`, `rec_setup`, `bulk_roster`), an `auth.users` stub for the `created_by` foreign key, and the harness stub parameters renamed to match `schema.sql` - `create or replace function` cannot change an input parameter name, so `member_role(p text)` blocked the real `member_role(p_league_id text)` from loading. CHECK 17 fails the build if a suite loses its marker, names a section that does not exist, or stops printing its counter. | FIXED (merged) |
| N-18 | LOW | ~~`bulk_import_roster` aborts an entire roster import on one nameless player.~~ **FIXED** - it inserted `ply->>'name'` raw while `rec_setup_game` guarded the same NOT NULL column, so a single player object with no name key took down the whole call. It now applies the same `Player` fallback. Proven first: without it D12 raised a not-null violation on `players.name`, and D14 showed `players=4 (expected 7)` - the other three players in the same call were never written. Applied to the live project 29/08/2026. | FIXED (merged) |
| N-19 | CRITICAL | ~~The live score reverted and then double-counted.~~ **FIXED.** `HYDRATE` replaced the whole event list with the server snapshot, and realtime fires a refetch on every write - so a snapshot READ BEFORE a tap's INSERT landed routinely ARRIVED AFTER it, wiping the basket; when the INSERT landed the next snapshot handed it back, by which time the scorekeeper had re-tapped. Reported as "+3, it reverted, then the next +3 added +6". The only defence was a 12-second undo tombstone, which covered removals and left pending inserts - the scoreboard itself - unguarded, and flipped its answer when its clock ran out. Replaced by `src/sync/pendingEvents.ts`: a ledger keyed by event id, retired by ORDERING (a fetch records the tick it started at; an entry retires only once the server confirmed it before that tick) rather than by a timeout. Proven by reverting the ledger alone: S9.3 `expected 3, got 0`, S9.4 `expected 6, got 3`. | FIXED (merged) |
| N-20 | HIGH | ~~A failed event write reported success.~~ **FIXED.** `pushAction` decided whether to rethrow with a regex over the error *message*; `INSERT_events` was not in the pattern, and React Native's `TypeError: Network request failed` carries no label to match anyway. So with the connection down every logged stat reported `saved`, the pending ledger was told the server had it, and the next pull deleted it - the score silently losing plays the scorekeeper had entered. The rethrow is now keyed off the action (`MUST_NOT_FAIL_SILENTLY`). Proven: with the old regex, S13.2 `expected "error", got "saved"` and S13.4 loses the stat. | FIXED (merged) |
| N-21 | HIGH | ~~`ts` alone is not a total order, so Undo could remove different rows on different devices.~~ **FIXED.** Two taps inside one millisecond tie, and PostgREST is then free to return them either way round while the local array kept insertion order - but "the last event of this game" IS the definition of Undo. Both sides now order by `(ts, id)`; redo reinserts in place instead of appending; and the reducer, the push and the ledger name the row by an id stamped once at dispatch (`stampActionIds`) rather than by array position. Proven: without the tie-break, S11.3-S11.11 and S12.2 show local and pulled order diverging. | FIXED (merged) |
| N-22 | HIGH | ~~A timed-out session probe was treated as "signed out", and purged the stored tokens.~~ **FIXED.** `ensureSession` could not distinguish "no session" from "no answer" - `withTimeout` returned the same `{ session: null }` fallback for both - and then ran `signOut({ scope: 'local' })` plus `signInAnonymously()`. `getSession()` resolves only after supabase-js refreshes an expired token over the network, so on an unreachable connection this fired on every launch, silently signing the user out and reassigning their drop-in games to a new uid. `sessionRecoveryPlan` in `src/store/authErrors.ts` now makes a non-answer never grounds for a destructive action. Proven: R23/R26. | FIXED (merged) |
| N-23 | MEDIUM | ~~One `lastError` string served every auth flow, so one flow's failure appeared inside another's modal.~~ **FIXED.** Reported directly: a failed Apple sign-in was still on screen inside the "Admin access" modal opened afterwards. The sign-in sheet, the password modal, the account screen and drop-in setup all read the same string and nothing cleared it. Errors are now scoped to the flow that produced them (`AuthScope`), and each sheet clears its own on open. Proven: with the shared string, R2/R3/R4 show the Apple error in the admin, account and code scopes. | FIXED (merged) |
| N-24 | MEDIUM | ~~Sign-in errors named the wrong layer, costing real debugging time.~~ **FIXED.** Every Supabase call on the reported device failed with `TypeError: Network request failed`, and the handlers answered "Is the Apple provider enabled in Supabase with this app's bundle ID?" - so the providers were checked twice while the actual cause went unmentioned. `describeAuthFailure` now classifies the failure: network failures read as network failures, only a genuinely disabled provider mentions the provider, and an audience rejection points at the `host.exp.Exponent` entry AUTH_SETUP.md documents. Proven: R14/R15. | FIXED (merged) |
| N-25 | MEDIUM | Google sign-in fails in Expo Go unless the `exp://` redirect is on the Supabase allowlist. **NOT A CODE DEFECT** - recorded because it cost a day and will recur. Supabase honours `redirect_to` only when allowlisted and silently falls back to the Site URL (`itala://auth-callback`), a scheme only a real build registers - so Safari is handed a URL no installed app claims and reports "the address is invalid", which reads as a broken app. Confirmed against the live project: `/auth/v1/verify?...&redirect_to=exp://...` returns the same `Location` as a deliberately bogus URL. A development/preview/production build is unaffected; its redirect IS the Site URL. The app now names the URL to allowlist, and docs/TROUBLESHOOTING.md carries the diagnosis. | DOCUMENTED |
| N-26 | MEDIUM | ~~A drop-in game that failed to save stayed in the list.~~ **FIXED.** `rec_setup_game` and `bulk_import_roster` are each one server transaction, so a failure means none of it was written - but the optimistic local copy survived, giving a game that appeared in the list, opened, and refused every write because nothing it referenced existed server-side. Cancelling the alert changed nothing, because nothing ever undid it. `ROLLBACK_BUNDLE` removes exactly the rows the bundle created, and the league only when that bundle created it. Proven: without it, S16.5 leaves the space in the league list and S17.2-S17.5 show a failed bundle polluting an existing league. | FIXED (merged) |
| N-27 | MEDIUM | ~~A password-elevated Super Admin could not start a drop-in game.~~ **FIXED.** `elevate_to_admin` raises whatever session the device has, and with no provider account that is an anonymous one; `rec_setup_game` gated on `is_authed_user()`, which excludes anonymous sessions. So a Super Admin verified by a bcrypt-checked, throttled password was refused there while this same schema grants them everything else through its blanket `is_admin()` policies - and the client agreed with the grant, not with the gate, which is why the app let them enter two full rosters before failing. Gate is now `is_authed_user() or is_admin()`. Not a widening of trust: `is_admin()` reads `profiles.is_admin`, which only `elevate_to_admin` can set. Proven: R12-R14 in `rec_setup.test.sql`. **Needs `schema.sql` re-run against production.** | FIXED (merged) |
| N-28 | LOW | ~~Route names were reaching users.~~ **FIXED.** "LeagueDetail" appeared in the top left: iOS labels the back button with the PREVIOUS screen's `title` and falls back to the route name when there is none, and most screens set `headerTitle` (the brand wordmark) without a `title`. `headerTitle` overrides what the header draws but is not a label, so the gap surfaced one screen away from the option that caused it. Every screen now has a human `title`; CHECK 1 fails the build if one is registered without. | FIXED (merged) |
| N-29 | LOW | ~~The play-by-play named a team only for timeouts, and its delete applied on the first tap.~~ **FIXED.** Telling the sides apart otherwise meant already knowing both rosters, and the row X sits millimetres from its row on a phone held courtside - a mis-tap rewrote the score silently. Rows now lead with the team badge AND name (colour alone fails a colour-blind scorekeeper, and two drop-in teams are routinely picked from the same palette), and deleting asks first, naming the play. Both play-by-play lists - the live sheet and the box score - held byte-identical copies of the label map and the row, so both now render `src/components/PlayLog.tsx`. | FIXED (merged) |
| N-30 | LOW | ~~Every Cloudflare branch build failed: `Missing entry-point to Worker script or to assets directory`.~~ **FIXED.** There was no wrangler config in the repo - the Worker's settings lived only in the dashboard, and its deploy command (`npx wrangler versions upload`) cannot know what to upload without one. `wrangler.jsonc` declares it as an assets-only Worker over `site/`, with `site/.assetsignore` keeping `site/README.md` from being served at `/README.md`. Checking it in also makes the deployment reviewable in a diff. | FIXED (merged) |
| N-31 | INFO | `waitForSession` read its subscription handle inside its own temporal dead zone. A callback firing during the subscribe call would have thrown `ReferenceError`, which the `?.` reads as though it guarded against - it does not; the reference itself throws. Caught in diff review, not by a test. | FIXED (merged) |
| N-32 | CRITICAL | ~~A committed stat reverted on its own, seconds later, with no undo and no second device.~~ **FIXED.** The N-19 ledger correctly protects a local write until a snapshot is read after the server confirms it - and then legitimately retires it. Nothing tracked which snapshot had ALREADY been applied, and there were five uncoordinated pull sites (boot, boot retry, post-auth re-pull, realtime refetch, pull-to-refresh), so two overlapping reads delivered out of order let the older reply win by arriving last: pull A reads 0 rows / tap 3PT / pull B reads 1 row and lands first, retiring the entry / pull A lands -> 0. Nothing pulled again, because nothing had changed on the server, so the board stayed wrong. `autoRefreshToken: true` plus an unfiltered `onAuthStateChange` also meant every TOKEN_REFRESHED fired one of those re-pulls mid-game. Fixed by a single serialised pull owner with one queued follow-up, plus `acceptSnapshot`: a monotonic watermark that refuses any snapshot older than the newest applied. Reproduced first, then pinned by S18/S19. | FIXED (PR) |
| N-33 | HIGH | ~~Undo put the basket straight back.~~ **FIXED.** The ledger was keyed by event id alone, so an ADD and the UNDO of that same row shared one slot, and `confirmPending(eventId)` could not tell which of the two it was acknowledging. Undoing a mis-tap ended with the INSERT's acknowledgement stamped onto the UNDO's entry, so the next snapshot retired the undo. Keyed by (operation, id) now, with a superseded write's confirmation correctly a no-op. Pinned by S20, and its mirror image - a redo retired by the DELETE it was reversing - by S21. | FIXED (PR) |
| N-34 | HIGH | ~~An empty read wiped every league on the device.~~ **FIXED.** An RLS read taken while the access token is mid-refresh returns an empty array rather than an error. The boot pull checked the length; the post-auth re-pull, the realtime refetch and pull-to-refresh did not, and hydrated it. One gate for every pull now: an empty snapshot is refused whenever the device already holds data. Pinned by S22. | FIXED (PR) |
| N-35 | MEDIUM | ~~The server row and the on-screen row disagreed on an event's timestamp.~~ **FIXED.** The reducer runs twice per action - once in the dispatch wrapper to build the rows the push mirrors, once inside React's `useReducer` - and `ADD_EVENT` read the clock itself, so the two runs differed by a millisecond or two. `ts` is half of the (ts, id) key that makes "the last event of this game" name the same row on both sides, which is the whole definition of Undo. Stamped once in `stampActionIds` now, as the later of the clock and one past the latest event already logged for that game - which also fixed Undo removing a randomly-tied row after a same-millisecond burst, since ids sort arbitrarily. Pinned by S25 and a new CHECK 9 clock assertion. | FIXED (PR) |
| N-36 | MEDIUM | ~~A substitution could revert to the pre-substitution lineup.~~ **FIXED.** Lineups, substitutions, the period and the status were protected by `lineupGuard`, a 2.5-second tombstone: too short for a slow push, and wrong the instant it expired. The game row now goes into the same ledger as the events, recorded by diffing the pre- and post-reducer state so the foul-out auto-bench is covered without the condition being named twice. `lineupGuard` is gone. Pinned by S23/S24. | FIXED (PR) |
| N-37 | INFO | **CHANGE REQUEST, not a defect.** Ties are gone from the data model and from every display. Basketball goes to overtime rather than drawing, so the record is W-L and a level final has NO RESULT: it counts towards neither team's wins, losses or streak, while its points still count towards PF/PA. `StandingRow.ties` and the third `winPctOf` argument are removed; `outcomeOf` KEEPS its `'tie'` case, because the box score, final-score screen and share card all have to render a level game without inventing a winner - which was F-11. The tracker now offers **Add period N+1** when FINISH is tapped at a level score, so overtime is the prompted path rather than a silent draw. This supersedes the tie half of N-03: games played on the team profile is now counted off the games themselves, not off W+L, so PPG cannot be inflated by a game that sits outside the record. GROUP M rewritten (21 -> 24 assertions) and P8 in tests/MANUAL-REGRESSION.md rewritten. | DONE (PR) |
| N-38 | CRITICAL | ~~Stats logged offline were gone after the app was closed and reopened, and the app claimed to be connected while it was not.~~ **FIXED.** Five reported bugs, three root causes. **(a) The pending-writes ledger lived only in memory.** A failed push pinned the entry so the local number survived on screen, but nothing retried it and the `Map` died with the process; the next launch hydrated the server's rows through an empty ledger and the autosave wrote that over the only durable copy. The ledger is now persisted to `hoops.outbox.v1` and replayed by row via `pushPendingEntry` through `enqueuePush`, restored BEFORE the first pull so a restored entry is unconfirmed and no snapshot may overwrite it. Replay upserts on a client-minted id, so a write that landed but whose reply was lost cannot double-apply. **(b) Reachability was inferred from an exception that never happens.** `@supabase/postgrest-js` 2.107.0 RESOLVES a transport failure with `{ error, data: null, status: 0 }` - verified empirically against this repo's own `node_modules`. So `check` swallowed an offline write and reported it saved: `SET_LINEUP`, `SET_LINEUPS`, `SUBSTITUTE`, `SET_ATTENDANCE`, `SET_GAME_STATUS` and `SET_PERIOD` were all marked confirmed, never queued, and reverted to the server's stale row on reconnect - N-36 recurring in the offline case. `pingServer` returned `true` in aeroplane mode and `fetchAllState` returned `null` while `pullState` recorded the read as reachable, which is why Settings said "Connected" offline and pull-to-refresh answered silently. All three now decide from the RESPONSE via `transportFailure(res)` (`isNetworkFailure(msg)` or `status === 0`); row-level rejections keep the old swallow-and-reconverge behaviour. `isNetworkFailure` also gained Node's `fetch failed` spelling, without which every test on a laptop misclassified a transport failure as a row-level one. **(c) The test harness disagreed with production on exactly this axis** - `fakeSupabase` threw where the real client resolves, so 86 green assertions proved nothing; it now models both shapes and the offline tests use the resolving one. Also: the recovery probe's backoff reset on every status flip, giving a ping plus a failed push every two seconds indefinitely, so the counter now outlives the effect; the ledger is gated on `SYNC_ENABLED`, since a local-only build could never confirm or drain what it recorded and filled to `MAX_ENTRIES`; the Home badge moved out of absolute positioning into normal flow under the avatar (it was laid over "Record. Track. Elevate." at a hard-coded offset); the live tracker's two-line failure block became a fixed-height chip in the Exit row, which used to push the scoreboard and the on-court five down mid-game; and that chip's loss of `accessibilityRole="alert"` was made good with an announcement on the phase transition. GROUP O extended to 320 sync assertions and 441 static checks; R113 in tests/MANUAL-REGRESSION.md corrected (it asserted the exact string this removes) and R146-R156 added. Each fix was verified by reverting it and confirming the suite fails: 21 failures for (b)'s push half, 8 for its reachability half, 1 for the local-only gating. | FIXED (PR) |
| N-39 | CRITICAL | ~~Stats logged with a live connection were gone after the app was closed and reopened - the game reopened at 0-0.~~ **FIXED.** `fetchAllState` read all five tables with no pagination. PostgREST will not return more rows than `db-max-rows` - 1000 on a default Supabase project - and it does not report having capped the reply: the response is an ordinary success carrying a short array, with no error and no status to test, so nothing distinguishes "these are all the rows" from "these are the first thousand of them". Two things turned that into deletion. The events query was ordered ASCENDING, so the rows dropped were the NEWEST - the game being scored right now. And the read is global and unfiltered: `read_all_*` grants SELECT to any signed-in caller (`supabase/schema.sql:421`) and the query carries no filter, so the cap is measured against every event in the database rather than one league's, and is crossed far earlier than a single league would suggest. The truncated-but-successful snapshot then went into `HYDRATE` with a `snapshotAt`; `reconcileLeagueEvents` returned only what the pending ledger still pinned; and after a RESTART the ledger is empty, because a confirmed entry is deliberately excluded from the persisted outbox - so the events were dropped from state as though another device had deleted them, and the autosave on the very next render wrote the emptied league over the only durable copy. This is why the write path and the sync badge were honest throughout, and why N-38's durable outbox did not cover it: the stats really did reach the server, nothing was queued, and "Synced" was true - the loss was on the READ. Every read now WALKS THE WHOLE TABLE BY KEYSET on `id`: `.order('id').limit(n)` then `.gt('id', cursor)`, finishing only on an EMPTY reply. **Offset paging was written first and rejected**, because `.range(from, to)` compiles to OFFSET/LIMIT and OFFSET is defined against a result set other devices are changing while it is walked - a `DELETE` behind the cursor (any scorekeeper's Undo, anywhere, since the read is global) shifts every later row down one, so the next window steps over a surviving row, and the exact count shrinks by the same one so `rows.length === count` reports success. That snapshot omitted a row the server still had AND kept one it had deleted; with the ledger empty after a restart, HYDRATE dropped the missing event and the autosave persisted it - N-39 again, reached by a stranger's Undo instead of by row count, and needing no restart to corrupt a running device. Three independent reviews reproduced it, one by driving the real `fetchAllState` against a fake PostgREST. A cursor on `id` has no such window: all five tables are `id text primary key`, immutable and unique, so "everything after this id" names the same boundary however the table is edited around it, a surviving row can never be stepped over, and completeness stops depending on a count that moves while the read runs - which also removed the `count: 'exact'` the offset version needed, a full COUNT(*) per request per table on every pull. Only an empty page proves the walk finished: a short page does not, because a project whose `db-max-rows` is below the client's page size answers every page short, and reading that as the end is the original truncation. Running out of pages, a cursor that fails to advance, or a row with no string `id` are all ERRORS - a short snapshot deletes rows, so refusing beats reporting one as the whole table. `MAX_PAGES` is now a runaway backstop rather than the offset version's de facto 200,000-row ceiling past which every pull failed for ever while the app still said "Connected". Because the cursor is `id` rather than the display order, the render order the five queries used to ask the server for is now imposed client-side (NULLs LAST ascending and FIRST descending, as Postgres does, with `id` breaking ties so the order is total where the server left ties arbitrary). GROUP T (T1-T8) pins all of it: T4 is the reported force-quit scenario and fails at HEAD with 0 points and a 0-point durable copy; T6/T7 are the delete-mid-read race and failed against the offset implementation with a named surviving row missing from both the board and the disk; T8 pins that a short page is never mistaken for the end. Nineteen GROUP T assertions fail at HEAD. A new provider suite (`tests/provider.test.js`) executes the real `StoreProvider` on a small hook runtime, so boot ordering, the autosave and the storage calls are exercised by the component itself rather than by a hand-written copy of it; `tests/harness/fakeSupabase.js` gained `gt`, a real `limit`, a row cap and a `beforeRead` hook for modelling a table that changes between two pages of one read. Caught while building the provider suite: `tests/harness/stubs/asyncstorage-live.js` lacked `__esModule: true`, so esbuild's `__toESM` set `default` to the whole `module.exports`, `.setItem` resolved to `undefined`, and the TypeError was swallowed by `saveState`'s best-effort catch - every storage read and write in that suite did nothing while reporting success, and its first apparent reproduction of this bug was a harness artefact. The stub is fixed and the suite now aborts at startup if a `saveState`/`loadState` round trip stops working. Two first attempts at the race tests also passed against the broken implementation and were rewritten: a query-builder wrapper does not survive `.order()`/`.limit()`, which return the real closure-bound builder. NOT VERIFIED: the cap's real threshold was never observed against a live Supabase project (no project access; `tests/sql/` skips with no psql on PATH) and there was no device or emulator - hence R157-R160, which exist because this failure is invisible to the automated suite on a laptop. | FIXED (PR) |

| N-40 | CRITICAL | ~~A game started right after a league was created never opened: the lineup screen span, the away team showed `?`, the card said "This game couldn't be loaded", and the edited team appeared TWICE in Standings - once with its logo and roster, once empty.~~ **FIXED.** One root cause behind all four. **The reducer runs twice for one dispatch** - `const next = reducer(prev, action)` in the dispatch wrapper builds the state `pushAction` mirrors, then `baseDispatch(action)` reduces the same action again for the state React renders - and `ADD_TEAM`, `ADD_PLAYER` and `DUPLICATE_LEAGUE` minted their new row's id with `uid()` INSIDE the reducer, so the two runs minted DIFFERENT ids. The SERVER was sent the wrapper's id; the DEVICE kept React's. From there the two disagreed about what the row was called: an edited team's `UPDATE_TEAM` upserted under the on-screen id and INSERTED a second server row (the duplicate, empty because every earlier `ADD_PLAYER` had gone to the other id), while a team that was never edited existed only under React's id, so the next `HYDRATE` - which replaces `teams`/`players` wholesale, since only `REC_SETUP_GAME`/`BULK_IMPORT_ROSTER` bundles are guarded - deleted it, leaving the game's `awayTeamId` naming a row the device no longer had (`GamesOnDateScreen.tsx` renders that as `?`; `LiveGameScreen` spins then reports the load failure). This violated documented invariant 1 in `.claude/PROJECT-CONTEXT.md`, "no random IDs in reducer cases". `stampActionIds` now resolves all three, once, from the pre-dispatch state, exactly as the event ids already were; an explicit id still passes through so `BULK_IMPORT_ROSTER` and `REC_SETUP_GAME` are untouched, and the reducer keeps `a.id ?? uid()` for direct calls in tests. The positional `teams[length - 1]` / `players[length - 1]` fallbacks in `sync.ts` (CHECK 3's two standing warnings) are now dead for screen-driven writes but were deliberately left in place rather than widening the change. **Separately, and reported in the same breath:** `NewGameScreen` dispatched `CREATE_GAME` on the way to lineup selection, so a game that was never tipped off was already live on the League page - most visibly when one side had no players, Tip off was correctly disabled, and backing out was the only move left. Tip off IS the creation now: the id is minted on the picker, carried as a `pending` route param, and `CREATE_GAME` is dispatched on the Tip-off press with both starting fives in the one write. Cleanup-on-unmount was rejected because a force-quit defeats it and `GamesOnDateScreen`/`LeaguesScreen` render non-live rows anyway. **Three defects found by review of that change and fixed here:** `CREATE_GAME` is now idempotent on the game id, because the id is minted once on the previous screen and two taps in one frame therefore both reached the reducer with the SAME id and prepended twice (duplicate React keys, double-counted standings; the old flow minted a fresh id per press, so this was new); an empty roster made `target` 0 so `selected.length === target` painted the chip GREEN - the screen's own colour for ready - above a Tip off that could never enable; and both lineup-screen failure states were dead ends with no control, now carrying "Back to league" like `LiveGameScreen` does. The screen's 1500 ms gate also only watched `game`, so a game whose TEAMS never arrived span for ever. UI, as reported: the league-name placeholder overflowed and Android stretched it inter-character ("S u n d a y  R u n, O f fi c e"); `Button`'s primary carried a 1px transparent border to match ghost's outer box, but RN lays children inside the border, so its gradient was drawn 2px narrower and shorter and Home's Drop-In read as longer than New League - the border is gone and its 1px folded into the gradient's padding, so the outer box is unchanged for all 61 callers including the four that pass their own; the hex readout in EditTeam is replaced by a colour NAME plus a chip, since a bare dot would have communicated by hue alone and the hex was the only text a screen reader had; `describeColor` names all 60 swatches uniquely (36 are generated from HSL and shared one label), the swatches gained a role, name and selected state, and went from 42x42 to 44x44. GROUP IDS/IDS2/IDG added to `tests/reducer.test.js` (348 assertions), P7-P11 to `tests/provider.test.js` (103), CHECK 27/28/29 to `tests/static.test.js` (661) - CHECK 28 maps every `uid()` in the reducer back to its `case` and fails if `stampActionIds` does not handle it, so a fifth minting case cannot be added unstamped, and it also constrains where `Date.now()` may land. Fail-before-fix confirmed by reverting: IDS2 reported two different team ids, IDG1/IDG3 two games for one tap. P11 is a deliberate green CHARACTERISATION test, not a guarantee: `recordPending` returns no tokens for `ADD_TEAM`/`ADD_PLAYER`/`ADD_LEAGUE`/`UPDATE_TEAM`/`DUPLICATE_LEAGUE` and `OutboxEntry.kind` is only `'event' \| 'game'`, so a roster written OFFLINE is still never queued and is still deleted by the next pull, and `games.home_team_id` has no FK to `teams` so the resulting dangling game is accepted by the server - the same symptom by a different route, unfixed and needing the outbox extended to teams and players. NOT VERIFIED: nothing was run on a device or emulator, so the chip colour, the blocking line's reading order, the swatch targets and labels, the Android placeholder and the Home bar are all unconfirmed - hence R161-R170. | FIXED (PR) |

### Verification evidence

`npm test` runs the type check plus the reducer/stats/parser, two-device sync and static
structural suites, then the SQL suites.

**Current state of `main` (`3a2d276`, PRs #17 and #18 merged), run 01/09/2026:**

```text
node tests/run.js                    PASS (exit 0)
  tsc --noEmit                       PASS - clean
  reducer / stats / parser           PASS - 265/265
  two-device sync                    PASS - 91/91
  static structural                  PASS - 378/0 (+2 pre-existing advisory warnings)
  SQL suites                         PASS - 86/86 across 8 suites
npx eslint .                         PASS - clean
```

The SQL suites ran locally for the first time here, against a portable Postgres
16.4 rather than only on CI - see `tests/README.md` for the recipe and the Git
Bash `PATH` trap that makes the runner claim `psql` is missing when it is not.

Every fix in N-19 to N-31 was verified by reverting it alone and confirming the
new assertions fail. A test that passes against the broken code proves nothing,
and three of these (N-19, N-20, N-21) overlap closely enough that only isolating
them showed each was independently load-bearing.

**Earlier snapshot - `main` (`477c891`, all seven PRs merged), run 28/08/2026:**

```text
node tests/run.js                    PASS (exit 0)
  tsc --noEmit                       PASS - clean
  reducer / stats / parser           PASS - 178/178
  two-device sync                    PASS - 32/32
  static structural                  PASS - 245/0 (+4 pre-existing advisory warnings)
  SQL suites                         SKIP - psql not on PATH
```

245 is the expected union: the per-branch counts below do not add up by simple addition because
CHECK 8's `RECORD_AUDIO` assertion was inverted rather than added, and CHECK 5's boundaries were
rewritten. Both CHECK 14 and CHECK 15 were re-proven non-vacuous on the merged tree (three
stripped semantics and three deleted disclosures, three failures each, then restored) - which
mattered, because N-10 had left CHECK 15 silently unexecuted until then.

Per-branch results as recorded at the time each branch was written:

```text
chore/ci-and-windows-tests
  tsc --noEmit          PASS (clean)
  reducer/stats/parser  PASS - 149/149
  two-device sync       PASS - 32/32
  static structural     PASS - 222/0 (+4 pre-existing advisory warnings)
  SQL suites            SKIP - psql not on PATH

fix/tied-scores
  tsc --noEmit          PASS      reducer  PASS - 170/170 (GROUP M: 21 assertions)
  sync PASS - 32/32     static   PASS - 222/0

feat/a11y-core
  tsc --noEmit          PASS      reducer  PASS - 149/149
  sync PASS - 32/32     static   PASS - 231/0 (CHECK 14: 9 accessibility checks)

refactor/remove-legacy-global-settings
  tsc --noEmit          PASS      reducer  PASS - 157/157 (GROUP N: 8 assertions)
  sync PASS - 32/32     static   PASS - 220/0

chore/store-compliance-and-privacy-policy
  tsc --noEmit          PASS      reducer  PASS - 149/149
  sync PASS - 32/32     static   PASS - 238/0 (CHECK 15: 13 policy/declaration checks)

npm ci --dry-run        PASS - lockfile in sync with package.json (CI's first step)
expo config introspect  PASS - RECORD_AUDIO and CAMERA both carry tools:node="remove" (F-10)
expo export (android)   PASS - exit 0, 3.63 MB Hermes bundle; the CI "bundle" job's command
SQL slice anchors       PASS - all 5 schema.sql sections resolve, every @requires names a real one

GitHub Actions          PASS - run 33168091475 on 1a813a4 (PR #9), all three jobs green:
                        Lint (ESLint) 30s, Types/reducer/sync/static/database 56s,
                        Bundle (Metro + Hermes) 47s. Read from the Actions REST API, which
                        became reachable when the repository was made public; the job and
                        step conclusions are the source, not an inference.
SQL suites              PASS - 39 assertions, 0 failed. First execution anywhere, against the
                        postgres:16-alpine service with ITALA_REQUIRE_DB=1. Counts read from
                        the CI log, not inferred:
                          admin_secret            17 passed, 0 failed
                          admin_upgrade           11 passed, 0 failed
                          settings_backfill        6 passed, 0 failed
                          settings_backfill_fresh  5 passed, 0 failed
                        Four further suites SKIPPED as manual - see N-17, which is the one
                        real gap this run exposed.
On-device screen reader NOT RUN - no device or emulator available
Prebuild / built APK    NOT RUN - manifest verified by introspection only
```

**Applied to the live Supabase project:** `supabase/schema.sql` was re-run successfully on
28/08/2026, which is what discharges the ordering constraint in **Resume here**.

The migration logic is now verified, which it was not when this section was first written. The
`settings_backfill` suites ran in CI and cover exactly the case that made the ordering constraint
dangerous: `B1 pre-migration league inherits the legacy global (false)`, `B2 explicit per-league
value is not overwritten`, `B5 track_turnovers defaults to true, not to the trackMisses global`
and `B6 app_settings table dropped`. `settings_backfill_fresh` covers the no-`app_settings` path
(`F1`-`F5`), and `F4` confirms a re-run does not clobber an explicit value - relevant because
`schema.sql` is designed to be re-runnable.

**Still unverified, and it is a different claim:** those suites prove the shipped migration SQL is
correct against synthetic pre-migration rows. They say nothing about what the *live* project's rows
actually became, which depends on what that project's old global happened to be. To confirm the
production outcome, query `leagues.track_misses` on the live project directly.

Each bug fix was confirmed to fail **before** the fix rather than assumed:

- **F-11** - 10 of the 21 GROUP M assertions failed against the old code, including
  `M11 0-0 final is not a home win :: expected [0,0], got [1,1]`.
- **F-08** - reproduced directly as `ENOENT`, then confirmed a second time by accident: a branch
  cut from `main` without the fix could not even bundle on Windows.
- **N-06** - making the migration ignore the legacy value failed
  `N1 legacy false seeds a pre-migration league :: expected false, got true`.
- **F-03** - CHECK 13 failed 3 times before `ci.yml` existed.
- **F-05/F-06/F-07** - CHECK 14 proven non-vacuous by stripping three semantics (228 passed,
  3 failed), then restoring.
- **F-22 and the policy** - CHECK 15 proven non-vacuous by deleting three disclosures (235 passed,
  3 failed), then restoring.
- **N-10** - reproduced exactly as CI hit it (`TS1005` in the type check, `SyntaxError` on load),
  and the fix verified by more than "it parses now": the resolved file was diffed against **both**
  merge parents, and the only removals in either direction are the intentional replacements from
  the other side (N-01's union boundaries, N-06's `SET_SETTINGS`, F-10's inverted `RECORD_AUDIO`
  assertion). A clean re-merge in a throwaway worktree confirmed every *other* file in `62fb42b`
  already matched, so the damage was isolated to one file.

---


## Findings Summary

| ID | Severity | Category | Finding | Confidence | Status |
|----|----------|----------|---------|------------|------------|
| F-01 | CRITICAL | Security | Plaintext admin password committed to git history in the initial commit | CONFIRMED | FIXED (risk accepted) |
| F-02 | HIGH | Security / Data Integrity | Live production Supabase URL + anon key tracked in git (`bpbl.txt`) | CONFIRMED | FIXED |
| F-03 | HIGH | CI/CD | No CI pipeline runs tests, lint, type-check, or build on PRs | CONFIRMED | FIXED (merged) |
| F-04 | HIGH | Correctness / Data Integrity | `DELETE_EVENT` doesn't reverse foul-out auto-bench, unlike `UNDO_EVENT` | CONFIRMED | FIXED (merged) |
| F-05 | CRITICAL | Accessibility | Live two-tap stat entry has no screen-reader announcements (no live regions) | CONFIRMED | FIXED (merged) |
| F-06 | HIGH | Accessibility | No accessibility roles/labels anywhere in the app, including the stat pad | CONFIRMED | FIXED (merged) |
| F-07 | HIGH | Accessibility | Game deletion is swipe-gesture-only, with no non-gesture fallback | HIGH CONFIDENCE | FIXED (merged) |
| F-08 | MEDIUM | CI/CD / Testing | `tests/run.js` cannot run natively on Windows (`execFileSync('npx')` ENOENT) | CONFIRMED | FIXED (merged) |
| F-09 | MEDIUM | CI/CD | No ESLint/Prettier configuration exists anywhere in the project | CONFIRMED | PARTIAL |
| F-10 | MEDIUM | Mobile / Security | Unused, unexplained `RECORD_AUDIO` Android permission | CONFIRMED | FIXED (merged) |
| F-11 | MEDIUM | Correctness | Tied final scores are silently recorded as home-team wins | CONFIRMED | FIXED (merged) |
| F-12 | MEDIUM | Correctness | `rosterParse.ts` misparses team names/headers under common real-world paste shapes | CONFIRMED | PARTIAL |
| F-13 | MEDIUM | Dependency | `npm audit`: 24 vulnerabilities in Expo/Metro build tooling (dev-time only) | CONFIRMED | OPEN |
| F-14 | MEDIUM | Performance | `LiveGameScreen` recomputes box score/milestones on unrelated app-wide state changes | HIGH CONFIDENCE | FIXED (merged) |
| F-15 | MEDIUM | Mobile / Performance | Team logo / promo images stored as base64 with no resize step, only quality compression | HIGH CONFIDENCE | OPEN |
| F-16 | MEDIUM | Performance | Unbounded play-by-play list rendered without virtualisation | MEDIUM CONFIDENCE | FIXED (merged) |
| F-17 | MEDIUM | Correctness / Concurrency | Substitution modal's "Set 5" lineup snapshot goes stale if state changes while open | CONFIRMED | FIXED (merged) |
| F-18 | MEDIUM | Correctness / Mobile | No rapid double-tap lock on the live stat pad | CONFIRMED | FIXED (merged) |
| F-19 | MEDIUM | Architecture | Duplicated ad hoc `setTimeout` retries for membership-row eventual consistency | HIGH CONFIDENCE | OPEN |
| F-20 | MEDIUM | Accessibility | Foul-out danger and other risk cues communicated by colour alone | HIGH CONFIDENCE | PARTIAL |
| F-21 | MEDIUM | Accessibility | Touch targets below guideline size on frequently-used live-game controls | CONFIRMED | OPEN |
| F-22 | MEDIUM | Documentation | README architecture list is stale (missing 6 of 19 screens); troubleshooting doc's New Architecture claim is stale | CONFIRMED / HIGH CONFIDENCE | FIXED (merged) |
| F-23 | LOW | Code Quality | Duplicated image-picker and share/screenshot-fallback logic across screens | HIGH CONFIDENCE | OPEN |
| F-24 | LOW | Code Quality | Several small duplicated helpers (`uid()`, team-resolution fallback, colour utilities embedded in a screen) | HIGH CONFIDENCE | PARTIAL |
| F-25 | LOW | Accessibility | Icon-only buttons and dense stat tables lack accessible labels/semantics | CONFIRMED / MEDIUM CONFIDENCE | PARTIAL |
| F-26 | LOW | Correctness | "Best all-around game" is selected by points only, not the existing composite rating | HIGH CONFIDENCE | FIXED (merged) |
| F-27 | LOW | Correctness | Share card can present a 0-stat player as "Player of the Game" at the start of a live game | HIGH CONFIDENCE | NOT A DEFECT |
| F-28 | LOW | Mobile Reliability | Milestone-banner timers not cleared on `LiveGameScreen` unmount | HIGH CONFIDENCE | FIXED (merged) |
| F-29 | LOW | Security | Verbose, unconditional auth-flow console logging ships in release builds | HIGH CONFIDENCE | FIXED (merged) |
| F-30 | LOW | Build Config | `tsconfig.json` omits `noUncheckedIndexedAccess`, relevant to the project's own documented `.find()` concerns | MEDIUM CONFIDENCE | OPEN |
| F-31 | INFO | Security | `.gitignore` has no forward-looking patterns for keystores/service-account JSON that `DEPLOYMENT.md` instructs creating later | HIGH CONFIDENCE | FIXED |
| F-32 | INFO | Various | Positive findings (see below) | CONFIRMED | n/a |

---

## Critical Findings

### F-01: Plaintext admin password committed to git history

> **RISK ACCEPTED - 28/08/2026, by the operator (repository owner).** F-01 is closed on this basis
> rather than by further remediation, because no remediation available to this repository can reach
> the exposure.
>
> **What was exposed:** the plaintext Super Admin password, committed in the initial commit of a
> **different repository** - the earlier, public predecessor of this project. It is not in this
> repository's history: `iTala-official` was started fresh, and its root commit is `3fab4c8`
> ("Fresh history: remove leaked secrets from git"). 21 commits, one root.
>
> **Why acceptance is the only option:** the exposure lives in another repository's history, which
> cannot be rewritten from here, and any clone or fork taken from it retains the value regardless.
> Git history rewriting is not a containment mechanism for a credential that has already been
> published - rotation is. So the decision is not "rewrite or accept", it is "rotate and accept".
>
> **Why it is a reasonable acceptance:** the credential is dead. The password has been rotated
> (confirmed 28/08/2026), so the published value no longer authenticates anything. The design it
> guarded has also changed: `supabase/schema.sql` now stores a bcrypt hash rather than a plaintext
> column, `elevate_to_admin` throttles guesses through `admin_attempts` with a 5-attempt /
> 15-minute lockout, and the comparison is constant-time. That matters more than it might appear,
> because the RPC is granted to `anon` and the anon key is inlined into the JS bundle by Metro -
> so the guess rate an attacker gets is whatever the database allows, from anywhere, with no app
> involved. CHECK 10 fails the build if a plaintext literal reappears in the client, the schema,
> `app.json`, `.env.example` or the docs.
>
> **One thing to know, since this repository is now public:** the old password value is still
> present in this tree on purpose, in three `tests/sql/` fixtures - `run.js`'s `legacy_admin`
> section, `admin_secret.test.sql` and `admin_upgrade.test.sql`. They reproduce the pre-hardening
> layout so the upgrade path can be tested against the real shipped SQL, and they are deliberately
> outside CHECK 10's file list. This is safe **only because the value is rotated and dead**. If it
> were ever reused anywhere, those fixtures would republish it.
>
> **Two CI results bear on this directly** (run 33168626884, `admin_secret` and `admin_upgrade`):
> - `A3 the leaked password is not the stored secret` - passing, so the published value is
>   confirmed not to be what the database now holds.
> - `U6 the pre-upgrade password still unlocks` - passing, and it is the important one. The upgrade
>   path deliberately carries an existing password across as a hash so it does not lock the operator
>   out, which means **hardening the schema alone never invalidated the leaked credential**. Only
>   rotation did. That is precisely why rotation, not history rewriting, was the load-bearing step.
>
> **Residual risk:** an attacker who found the old value in the predecessor repository learns the
> project's historical password-choice habits, and nothing more. No live credential is recoverable
> from it.

**Severity:** CRITICAL
**Category:** Security - secrets management
**Location:** Git history only, commit `fea56be` ("Initial commit. iTala baseline") - `src/store/AdminProvider.tsx` (a `LOCAL_FALLBACK_PASSWORD` constant) and `supabase/schema.sql` (a plaintext value seeded directly into the `admin_secret` table). Remediated in commit `4cf55af` ("Undo sync and fix admin secret"), which is already merged to `main` (PR #1) and moved the schema to a salted bcrypt hash with attempt throttling.

**Evidence:** Directly confirmed by inspecting the initial commit with `git show fea56be:supabase/schema.sql` and `git show fea56be:src/store/AdminProvider.tsx`: the initial commit contains a real, human-readable password both as a client-side JavaScript string constant and as a literal value inserted into the database schema file. The current `HEAD` (`supabase/schema.sql`) no longer contains this value; it has been replaced with a `password_hash` column populated via `set_admin_password()`, and `tests/sql/admin_secret.test.sql` now explicitly regression-tests that the leaked value is not the live stored secret - which confirms the project's own team is already aware this specific password is compromised.

**Impact:** Git history is permanent by default. Anyone who has ever cloned this repository (it has a GitHub remote at `github.com/heeaaa/iTala.git`) can recover this password with `git log -p` or `git show fea56be`, regardless of what the current `HEAD` contains. If this password was ever live on a real Supabase project's `admin_secret` table, or reused anywhere else, it must be treated as permanently public.

**Recommendation:**
1. Confirm the password was actually rotated on every Supabase project that ever used it, via `select public.set_admin_password('<new password>');` - the test suite's framing implies this was done, but it could not be verified without database access from this audit.
2. Treat the historical value as permanently burned regardless; do not reuse it anywhere.
3. Decide whether to rewrite git history (`git filter-repo` or BFG) to remove it. This requires coordinating a force-push with every collaborator and does not remove copies already cloned/forked elsewhere, so it is a risk-reduction step, not a guarantee - weigh the disruption against the marginal benefit given the password should already be rotated.
4. Confirm the password was not reused for any other account or service.

**Confidence:** CONFIRMED (verified directly against git history in this audit)

---

## High Findings

### F-02: Live production Supabase credentials tracked in git (`bpbl.txt`)

**Severity:** HIGH
**Category:** Security / Data Integrity
**Location:** `bpbl.txt` (repository root), tracked since the initial commit under the name `"iTala - Supabase configuration.txt"`, renamed (not removed) to `bpbl.txt` in commit `5260a44`.

**Evidence:** `bpbl.txt` contains `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` values. Comparing against the real (correctly gitignored, untracked) `.env` file confirms these are the exact same, currently-active credentials - this is not a stale or placeholder value. `.gitignore` only matches `.env`, `.env.local`, and `.env.*.local`, so this `.txt`-named copy was never covered by it and has been committed and (via the configured `origin` remote) pushed the entire time.

**Impact:** The project's own documentation correctly argues the anon key is safe to embed in the shipped app binary because row-level security protects writes - and that argument holds here too, so this is not a write-access compromise. The practical impact is narrower but real: `supabase/schema.sql`'s read policies allow *any* signed-in session, including anonymous ones, to read every league, team, player, game, and event in the database ("read-anywhere" is a deliberate design choice for spectator support, documented in `AUTH_SETUP.md`). Having the exact project reference sitting in a plainly-committed file removes the small amount of friction that would otherwise come from having to extract the key from a compiled app binary, and stands in contrast to the project's own care around `.env` hygiene elsewhere (`DEPLOYMENT.md` explicitly warns never to commit `EXPO_PUBLIC_ADMIN_LOCAL_PASSWORD`, for example). It also has no purpose in the running application - nothing in `src/` references `bpbl.txt`.

**Recommendation:** Remove `bpbl.txt` from the working tree and, given it has been tracked since the very first commit, from git history as well (same tooling/considerations as F-01, and ideally handled in the same pass). Rotate the anon key (regenerate it in the Supabase dashboard) as a precaution, and add a defensive `.gitignore` pattern (e.g. flag any file containing `SUPABASE_ANON_KEY` in a pre-commit hook, or simply avoid ever pasting real config into a file outside `.env`).

**Confidence:** CONFIRMED (independently identified by this audit and two independent review agents; verified directly against git history and the live `.env`)

---

### F-03: No CI pipeline runs tests, lint, type-check, or build on PRs

**Severity:** HIGH
**Category:** CI/CD
**Location:** `.github/workflows/` (only file present: `supabase-keepalive.yml`)

**Evidence:** The only GitHub Actions workflow pings a Supabase RPC every 3 days to prevent the free-tier project auto-pausing. `tests/README.md` documents in detail what the project believes *should* run (`tsc --noEmit`, the reducer/stats/parser suite, the two-device sync suite, static structural checks, and a SQL suite) - none of this is wired into any workflow that triggers on `push`/`pull_request`.

**Impact:** A pull request can merge to `main` with type errors, a broken reducer, a broken sync layer, or a violated structural invariant (e.g. the route/reducer-parity checks, or the "no hard-coded password literal" check that would have caught F-01 automatically had it existed at the time) and nothing will catch it before merge. Since GitHub Actions runners are Linux (`ubuntu-latest`), none of this is blocked by the Windows-specific issue in F-08 - this is a pure tooling gap, not something waiting on another fix.

**Recommendation:** Add a `.github/workflows/ci.yml` triggered on `pull_request` and `push` to `main` that runs `npm ci`, `npx tsc --noEmit`, and `node tests/run.js` (the reducer/sync/static suites at minimum; the SQL suite can run against a `postgres:` service container in the same job). Mark it as a required status check via branch protection once green.

**Confidence:** CONFIRMED

---

### F-04: `DELETE_EVENT` does not reverse a foul-out auto-bench

**Severity:** HIGH
**Category:** Correctness / Data Integrity
**Location:** `src/store/StoreProvider.tsx:423-426` (`DELETE_EVENT`), contrasted with `:375-411` (`UNDO_EVENT`)

**Evidence (confirmed directly by this audit's own reading of the reducer):**
```ts
case 'DELETE_EVENT':
  return mapLeague(state, a.leagueId, l => ({
    ...l, events: l.events.filter(e => e.id !== a.eventId),
  }));
```
`UNDO_EVENT` explicitly checks whether the popped event was the `'pf'` that crossed the foul-out limit and, if so, restores the player to `homeOnCourt`/`awayOnCourt` (space permitting). `DELETE_EVENT` has no equivalent logic at all, despite being reachable from the play-by-play list in both `LiveGameScreen` and `BoxScoreScreen`, and - unlike `UNDO_EVENT` - able to delete *any* event in the game, not only the most recent one.

**Impact:** If a scorekeeper deletes a player's foul-out-triggering `'pf'` event (a plausible correction after a misclick), the reducer removes the foul from their count but never re-adds them to the court. The player is left stranded on the bench by stale `homeOnCourt`/`awayOnCourt` state, with their foul total now under the limit and no UI indication that anything is wrong (contrast with `ADD_EVENT`'s explicit foul-out alert). The scorekeeper has to notice and manually re-substitute the player.

**Recommendation:** Give `DELETE_EVENT` the same foul-out-reversal treatment as `UNDO_EVENT`: after removing the event, if it was a `'pf'` for a player whose foul count is now below the effective limit and who isn't already on court (with room available), add them back.

**Confidence:** CONFIRMED (verified directly against the reducer source in this audit; independently reported by the QA review agent with matching evidence)

---

### F-05: No screen-reader announcements anywhere in the live two-tap stat flow

**Severity:** CRITICAL
**Category:** Accessibility
**Location:** `src/screens/LiveGameScreen.tsx:348-353`, `:420-424` (status line), `:359-364` (milestone banner)

**Evidence:** The entire two-tap workflow's feedback (what was just armed, what was just logged) is a plain `<Txt>` status line with no `accessibilityLiveRegion="polite"` (Android) or `AccessibilityInfo.announceForAccessibility()` equivalent (iOS/cross-platform), and no re-focusing after a tap.

**Impact:** A screen-reader user arms a stat (tap 1) and taps a player (tap 2) but receives no spoken confirmation of what was armed or what was logged - the only feedback is a colour/text change elsewhere on screen that VoiceOver/TalkBack will not announce unless the user manually navigates to it after every single tap. This is the app's single most-used interaction, and as built it is effectively unusable non-visually, with a real risk of silently mis-logged stats for a screen-reader user.

**Recommendation:** Wrap the status view in `accessibilityLiveRegion="polite"` on Android and call `AccessibilityInfo.announceForAccessibility()` inside `arm()` and `log()` (cross-platform) to announce e.g. "armed: 3-pointer" and "logged: 3-pointer for [player]".

**Confidence:** CONFIRMED

---

### F-06: No accessibility roles or labels anywhere in the app

**Severity:** HIGH
**Category:** Accessibility
**Location:** App-wide - `src/components/ui.tsx` (`Button`, `Card`, `Pill`, `Segmented`, `Toggle`) and all 19 screens; specifically the live stat pad at `src/screens/LiveGameScreen.tsx:480-495`.

**Evidence:** A repository-wide search for `accessibilityLabel`/`accessibilityRole` returns a hit in only one of nineteen screen/component files (a single close button). The stat pad itself is built from plain `<Pressable>` elements with no `accessibilityRole="button"` or `accessibilityState`.

**Impact:** Screen-reader users get no reliable indication that these elements are actionable, and no announcement of "armed"/"selected" state, which is currently conveyed only by a background colour swap. This affects essentially every interactive control in the app, not only the live pad.

**Recommendation:** Add `accessibilityRole="button"` (and `accessibilityState` where relevant) to the shared `Button`, `Card` (when pressable), `Pill`/`Segmented`, and `Toggle` primitives in `ui.tsx` so the fix propagates app-wide, then address the stat pad and any other bespoke controls individually.

**Confidence:** CONFIRMED

---

### F-07: Game deletion is swipe-gesture-only with no accessible fallback

**Severity:** HIGH
**Category:** Accessibility
**Location:** `src/components/ui.tsx:272-302` (`SwipeableRow`), `src/screens/GamesOnDateScreen.tsx:62-63, 99-103`

**Evidence:** Deleting a logged game is only reachable via a left-swipe gesture, with the only affordance being a text hint ("Swipe a game to the left to delete it"). There is no visible delete button, long-press menu, or `accessibilityActions` fallback.

**Impact:** Horizontal swipe gestures are commonly intercepted by screen readers for element-to-element navigation (VoiceOver/TalkBack), so this destructive action may be unreachable for screen-reader, switch-control, or motor-impaired users - and it is the only delete-game affordance available to owners.

**Recommendation:** Add a non-gesture fallback (a long-press context menu, or `accessibilityActions`/`accessibilityCustomActions`) so the action does not depend on a swipe gesture.

**Confidence:** HIGH CONFIDENCE

---

## Medium Findings

### F-08: `tests/run.js` cannot run natively on Windows

**Severity:** MEDIUM
**Category:** CI/CD / Testing
**Location:** `tests/run.js` (all `execFileSync('npx', ...)` calls)

**Evidence:** `execFileSync('npx', ['--version'])` throws `ENOENT` (errno `-4058`) on native Windows, because `npx` is a `.cmd` shim and `execFileSync`/`spawn` cannot resolve `.cmd` executables without `shell: true`. This was reproduced directly in this environment. A `cmd.exe /c` wrapper was used to work around it in order to actually execute the suites for this audit's Verification Performed section.

**Impact:** `npm test` is unusable out of the box for any contributor on native Windows - a real population, since this very audit session runs on Windows - forcing an undocumented workaround before local verification is possible. It has no effect on Linux CI runners.

**Recommendation:** Pass `{ shell: true }` to the `execFileSync` calls in `tests/run.js`, or invoke `npx.cmd` explicitly on `win32`.

**Confidence:** CONFIRMED

---

### F-09: No ESLint/Prettier configuration exists

> **Updated 28/08/2026. PARTIAL.** ESLint is in place and gating; the Prettier half is not.
>
> **Done:** `eslint.config.js` (flat config) on `eslint-config-expo` 10.x - the SDK 54-era release,
> since later versions renumbered to track SDK numbers and 55.x+ pull the wrong plugin set - plus
> `eslint-config-prettier` so the two tools cannot disagree about the same line. `npm run lint`,
> `lint:fix`, `format` and `format:check` scripts, and a dedicated `lint` CI job running on
> `pull_request`. CHECK 16 guards that the config, the script and the workflow step all still exist,
> and that unused symbols stay an *error* rather than drifting back to a warning.
>
> **The first run reported 59 problems, and all were fixed rather than suppressed.** That is where
> the value turned out to be: it surfaced **N-11**, a genuine crash (`useState` after an early
> return in `EditTeamScreen`, which throws "Rendered more hooks than during the previous render"
> once a league arrives via `HYDRATE`), plus N-07, N-12 and N-13. Nothing else in the project could
> have found N-11 - `react-hooks/rules-of-hooks` had never run.
>
> **Two deliberate relaxations, both justified rather than convenient:**
> - `react/no-unescaped-entities` **off**. It exists to stop a bare apostrophe breaking HTML
>   parsing. RN's `<Text>` renders string children literally, so `"Player's"` is correct as written
>   and escaping it would show the user a literal `&apos;`. It accounted for 18 of the 59.
> - `react-hooks/exhaustive-deps` **warn**. Its only two hits are F-14. Correcting a dependency
>   array changes when a memo recomputes, which needs the F-14 work and its own tests, not a
>   drive-by edit in a tooling PR. Left visible on every run so it is not forgotten.
>
> **CI history, for honesty:** the first push of this work failed all three CI jobs at `npm ci`
> (N-15). The lint job itself had never run. Nothing in the ESLint work was wrong; the lockfile
> was. Recorded because "the linter is green locally" was not the same as "CI is green", which is
> the whole point of F-03.
>
> **Not done:** Prettier is installed and configured but **not applied and not gated**. It would
> reformat all 54 files in the repo; that is a mechanical commit of its own, and it carries a real
> hazard worth flagging - CHECK 1-16 match exact source strings in places, so a reformat can make a
> check vacuous without failing it. Three CHECK 14 needles were spot-checked and survive Prettier,
> but the full set has not been verified. `npm run format:check` currently reports 54 files.

**Severity:** MEDIUM
**Category:** CI/CD
**Location:** Repository root (no `.eslintrc*`, `eslint.config.*`, or `.prettierrc*` found; no corresponding devDependency in `package.json`)

**Evidence:** `tests/static.test.js` covers a set of bespoke structural invariants, but nothing enforces general code style, unused imports/variables, React hooks rules (e.g. `exhaustive-deps`), or common bug patterns beyond what that hand-written suite happens to check.

**Impact:** There is currently no tool that could even be added to a CI workflow for a "lint" step - the gap is tooling, not only wiring.

**Recommendation:** Add ESLint with `eslint-config-expo` (matches SDK 54) and a Prettier configuration, with `npm run lint` / `npm run format:check` scripts, then include both in the CI workflow recommended in F-03.

**Confidence:** CONFIRMED

---

### F-10: Unused, unexplained `RECORD_AUDIO` Android permission

**Severity:** MEDIUM
**Category:** Mobile Reliability / Security (least privilege)
**Location:** `app.json:34-36` (`android.permissions`), pinned in place by `tests/static.test.js:144-145`

**Evidence:** `app.json` declares `android.permission.RECORD_AUDIO`. A repository-wide search for `RECORD_AUDIO`, `microphone`, `expo-av`, and `Audio.` found no functional usage anywhere in `src/` - no dependency (`expo-av` or otherwise) that would justify it is present in `package.json` either. There is no corresponding `NSMicrophoneUsageDescription` in `ios.infoPlist`, so the platforms are inconsistent as well. This was independently identified by three separate reviewers in this audit (mobile/performance, security, and dependency/CI), all converging on the same conclusion.

**Impact:** A basketball scorekeeping app requesting microphone access with no corresponding feature increases the app's Play Store privacy/permissions footprint for no functional benefit, raises user-trust questions, and can trigger app-store review scrutiny. The pinning test suggests this may be deliberate leftover scaffolding for a planned feature rather than an accident, but nothing in the repository documents an intended use.

**Recommendation:** Confirm with the team whether this is planned for a near-term feature. If not, remove it from `app.json` and the corresponding assertion in `tests/static.test.js`. If it is planned, document it and add the matching iOS usage-description string now.

**Confidence:** CONFIRMED

---

### F-11: Tied final scores are silently recorded as home-team wins

**Severity:** MEDIUM
**Category:** Correctness
**Location:** `src/lib/stats.ts:95` (`standings()`); the same `score.home >= score.away` pattern is repeated in `src/screens/BoxScoreScreen.tsx:142,146,150,151` and `src/screens/GamesOnDateScreen.tsx:74`

**Evidence:** `const homeWon = s.home >= s.away;` - a tied score resolves to `true`. Nothing in the reducer or UI prevents marking a game `'final'` while the score is level (the app supports extra periods for overtime, but nothing enforces playing one out).

**Impact:** A scorekeeper who stops tracking at a tied score (or mis-taps Finish) produces a standings row that silently credits the home team with a win, corrupting win/loss records, streaks, and season-ending "Champion" declarations (`SeasonRecapScreen` treats `standings(league)[0]` as an unambiguous winner). The same faulty pattern is duplicated across three files rather than centralised.

**Recommendation:** Either block finishing a game while scores are tied (prompting to continue to overtime), or have `standings()` treat a tie as a draw (excluded from win/loss tallies, or tracked as a separate `ties` column) and apply the same fix consistently across all three call sites.

**Confidence:** CONFIRMED (independently identified with matching line-level evidence by two separate review agents in this audit)

---

### F-12: `rosterParse.ts` misparses common real-world paste shapes

> **Updated 29/08/2026. PARTIAL** - the digit-in-team-name bug is fixed, the
> back-to-back-header case now has a one-tap repair, and one shape is documented as
> a deliberate limitation.
>
> **The finding understated the damage.** It described a team name containing a digit
> being parsed as a player. What actually happened is worse: because no header was
> ever recognised, the team also fell back to the `Team N` placeholder and its real
> name was consumed. Reproduced before fixing:
>
> | Paste | Before | After |
> |---|---|---|
> | `Eagles 2024` | team `"Team 1"`, player `Eagles` #`2024` | team `"Eagles 2024"` |
> | `U14 Warriors` | team `"Team 1"`, player `U14 Warriors` | team `"U14 Warriors"` |
> | 3 such teams in one paste | one team, 6 players | 3 teams, 1 player each |
>
> **Root cause:** header detection was `!/\d/.test(line)` - any digit anywhere was
> taken as proof of a player line. It now asks whether the line carries a *player-line
> signal* (`#N`, `-N`, a bare trailing `N`, or a leading index), which is the actual
> distinction. Extraction and detection share the same four regexes so they cannot
> drift apart - a line looking like a player to one and not the other is exactly how a
> team name got eaten.
>
> **One extra change:** a bare trailing run of 4+ digits is now read as a year, not a
> jersey number. Capped at 3 because the project's own sample roster contains a
> `420`.
>
> **Back-to-back headers** (two teams pasted with no blank line between) still parse
> as one team with a flagged row, because that shape is genuinely
> indistinguishable from the "Jun" stray already in the sample. Guessing would
> silently lose a player or split a team. Instead `promoteStrayToTeam()` - a pure,
> unit-tested function - powers a **"↳ Make this a team"** action on flagged rows in
> `BulkImportScreen`, carrying the rows below the header into the new team. That is
> the review-UI action this finding recommended.
>
> **Known limitation, asserted so it stays visible (O13):** a short `"Name N"` header
> such as `Team 2` is still read as a player, because it is structurally identical to
> `Pedro Santos 9`. No rule separates them without guessing.
>
> **Coverage:** GROUP O, 25 assertions. 9 were confirmed failing against the old
> parser first, including `O5 expected ["Eagles 2024","Hawks 2025","U16 Kings"], got
> ["Team 1"]`. GROUP G's 19 existing assertions against the real messy sample are
> unchanged, which is what shows the fix did not trade one paste shape for another.
>
> **Still open:** nothing in the parser. The remaining gap is that
> `BulkImportScreen` has no automated coverage at all - `promoteStrayToTeam` is
> tested, the screen wiring is not, and this project has no component-test harness.

**Severity:** MEDIUM
**Category:** Correctness
**Location:** `src/lib/rosterParse.ts:29, 79-97` (header detection)

**Evidence:** Team-header detection relies solely on `hasDigit(line)` - a line with no digit is treated as a new team header. Any real team name containing a number ("Team 2", "U14 Warriors", "Eagles 2024") therefore never triggers header detection and is instead parsed as a player line (e.g. "Eagles 2024" becomes player name "Eagles", number "2024"). Separately, a second team's header is only recognised when preceded by a blank line; teams pasted back-to-back with no blank separator have the second header swallowed into the first team's roster as a flagged "possible stray line" rather than starting a new team.

**Impact:** Both are realistic shapes for a roster pasted from a group chat or spreadsheet, exactly the "messy real-world paste" scenario this parser is designed for, and both currently corrupt the import rather than flagging it clearly for review.

**Recommendation:** Special-case common header patterns containing digits (e.g. leading age-group tokens), and/or treat a no-digit line as a new header when it is immediately followed by clearly-different player lines even without a blank-line separator; add a "promote to new team" action in the `BulkImportScreen` review UI for flagged stray rows.

**Confidence:** HIGH CONFIDENCE

---

### F-13: `npm audit` reports 24 vulnerabilities in build tooling

**Severity:** MEDIUM
**Category:** Dependency
**Location:** Transitive dependencies of `expo` (Metro, `@expo/cli`, `@expo/config-plugins`, `xcode`, `tar`, `shell-quote`, `js-yaml`, `nanoid`, `undici`, `brace-expansion`, `uuid`, and others)

**Evidence:** `npm audit` reports 1 critical, 14 high, and 9 moderate advisories, all in packages that run at build/dev time (Metro bundling, EAS/Xcode prebuild tooling) rather than being bundled into the shipped app JavaScript. A subset (`brace-expansion`, `js-yaml`, `nanoid`, `shell-quote`, `tar`, `undici`) is fixable via `npm audit fix` without a breaking change; the rest requires `npm audit fix --force`, which would jump `expo` to a 3-major-version-newer release.

**Impact:** End-user risk is low since none of this runs on-device in the shipped app. The real risk is to developer machines and any CI/build server that unpacks dependency tarballs or runs prebuild scripts against these versions (`tar`'s advisories in particular cover DoS/path-confusion issues relevant to unpacking untrusted archives).

**Recommendation:** Run `npm audit fix` as routine maintenance for the non-breaking subset. Treat the `expo@57` upgrade needed to close the rest as a deliberate, tested migration - `DEPLOYMENT.md` already documents this as a planned future step, so this is a known, scheduled item rather than a surprise. Do not run `--force` casually.

**Confidence:** CONFIRMED

---

### F-14: `LiveGameScreen` recomputes on unrelated app-wide state changes

**Severity:** MEDIUM
**Category:** Performance
**Location:** `src/screens/LiveGameScreen.tsx:68` (`useMemo` for `score`) and `:177-209` (milestone-detection `useEffect`)

**Evidence:** Both hooks depend on the top-level `state` object from `useStore()`, which is the entire app's `AppState.leagues` array (confirmed against `src/store/StoreProvider.tsx:101`), not a value scoped to the current game.

**Impact:** Any dispatch anywhere in the app while `LiveGameScreen` is mounted - including a background realtime sync pull updating a completely different league - re-runs the full box-score derivation and milestone scan (nested loops over every event of both teams) even when nothing about the current game changed. During a live game with sync enabled, this means unrelated activity elsewhere in the shared/community space can cause needless recomputation on the scorekeeper's screen mid-game.

**Recommendation:** Depend on the specific game/league slice (e.g. the already-derived `league` via `useLeague(leagueId)`, or a memoised reference to `game.events`) instead of the raw top-level `state`.

**Confidence:** HIGH CONFIDENCE

---

### F-15: Team logo and promo images stored as base64 with no resize step

**Severity:** MEDIUM
**Category:** Mobile Reliability / Performance
**Location:** `src/screens/EditTeamScreen.tsx:75-78`, `src/screens/ManagePromosScreen.tsx:30-33`

**Evidence:** Both `ImagePicker.launchImageLibraryAsync` calls set `quality: 0.4`/`0.35` (JPEG compression ratio only) but perform no dimension-resize step (no `expo-image-manipulator` or equivalent) before encoding to a `data:image/jpeg;base64,...` URI. `allowsEditing`/`aspect` constrain crop ratio only, not final resolution.

**Impact:** A photo from a modern phone's library can still produce a multi-megabyte base64 string even after quality compression. Per `src/types.ts`, these strings are stored directly in `Team.logo`/`Promo.image`, which are (a) included in every AsyncStorage autosave write (`src/store/storage.ts` writes the whole state on every reducer change) and (b) synced to Supabase as `text` columns with no length constraint, inflating sync payload size and realtime traffic. `supabase/schema.sql` itself acknowledges this as an accepted "V1, migrate to Storage if the library grows" tradeoff, but the shared community league (writable by any signed-in user) makes uncontrolled growth more likely over time.

**Recommendation:** Add a bounded max-dimension resize (e.g. 512px for logos, 1200px for promo banners) via `expo-image-manipulator` before the base64 conversion, in addition to the existing quality compression.

**Confidence:** HIGH CONFIDENCE

---

### F-16: Unbounded play-by-play list rendered without virtualisation

**Severity:** MEDIUM
**Category:** Performance
**Location:** `src/screens/LiveGameScreen.tsx:517-526, 771-803` (`PlayByPlayModal`)

**Evidence:** `PlayByPlayModal` renders `events.slice().reverse()` for the entire game (uncapped) inside a `ScrollView` + `.map()`, not a `FlatList` or other virtualised list.

**Impact:** A long, high-scoring, foul-heavy game can accumulate 150-300+ individually-logged events. Every one becomes a live React element with no windowing when the modal opens, which is a real (though not empirically profiled here) risk of jank, particularly since this same modal is also reachable by spectators.

**Recommendation:** Switch to `FlatList` with `inverted` (a natural fit, since the list is already reversed) or another windowing approach.

**Confidence:** MEDIUM CONFIDENCE (plausible risk from code inspection; not load-tested against an actual long game's event count)

---

### F-17: Substitution modal's lineup snapshot can go stale while open

> **Updated 29/08/2026. FIXED (PR).** Confidence raised from MEDIUM to CONFIRMED - the mechanism
> is exact, not suspected.
>
> `SubModal` seeds its selection with `useState(onCourtIds)`, and `useState` reads its initial
> value only on mount. The sheet stays mounted while open, so a realtime `HYDRATE` from another
> device (or an auto-bench) changes who is on court underneath it while `selected` keeps the old
> five. Confirming then writes a lineup built from a world that no longer exists, silently
> reverting the other device.
>
> Worth noting what was **already** safe: the confirm filters `!fouledOut.has(id)`, and
> `fouledOut` is a prop recomputed on re-render, so the foul-out case never leaked through. The
> reachable bug is a lineup change from another device.
>
> **Not fixed with a re-seeding `useEffect`**, which would wipe the user's picks every time any
> app-wide state changed. Instead `reconcileLineup()` distinguishes three cases: unchanged (do
> nothing), changed with no edits yet (adopt silently, the user loses nothing), changed *with*
> edits (raise a conflict). The third case is deliberately not resolved automatically - applying
> discards the other device's change, discarding throws away the picks just made, and neither is
> ours to choose. The sheet shows an `accessibilityLiveRegion` warning with a "Start again from
> the current lineup" action, and confirming asks.
>
> The court key is order-independent, so the same five arriving in a different order is not
> treated as a substitution and raises no spurious prompt.

**Severity:** MEDIUM
**Category:** Correctness / Concurrency
**Location:** `src/screens/LiveGameScreen.tsx:654-655` (`SubModal`)

**Evidence:** `const [selected, setSelected] = useState<string[]>(onCourtIds);` captures the on-court lineup once at modal-mount time and never resyncs while the modal stays open.

**Impact:** If the on-court lineup changes underneath the modal while it is open - a realtime sync update from another device/scorekeeper, or an `ADD_EVENT` foul-out auto-benching a player - tapping "Confirm lineup" dispatches `SET_LINEUP` built from the stale snapshot, silently reverting the concurrent change (e.g. bringing back a just-fouled-out player, or dropping one just added elsewhere). This is exactly the class of race the project is otherwise careful about (see the pending-writes ledger and `bundleGuard` at the store layer).

**Recommendation:** Reseed `selected` from `onCourtIds` via a `useEffect` keyed on `onCourtIds` (guarded against clobbering in-progress user taps), or diff against the latest `onCourtIds` at confirm time rather than trusting the mount-time snapshot.

**Confidence:** MEDIUM CONFIDENCE

---

### F-18: No rapid double-tap lock on the live stat pad

> **Updated 29/08/2026. FIXED (PR).** Confidence raised from MEDIUM to CONFIRMED, and the finding
> was righter than it looked - but for a subtler reason than "there is no lock".
>
> There *was* a guard: `log()` opened with `if (!armed) return` and called `setArmed(null)`
> afterwards. It does not hold. `armed` is a `useState` value captured in the tap handler's
> closure, and `setArmed(null)` does not change that captured value. Two taps processed before the
> re-render commits therefore both see the stat armed and both dispatch `ADD_EVENT` - one fumbled
> double-tap becomes two points, or two fouls, mid-game. The `disabled={!armed}` on the chip has
> the same weakness: it only takes effect once the render commits.
>
> Fixed by making the claim atomic rather than by adding a timer. `armedRef` mutates immediately,
> and `claimOnce()` reads and clears it in one step, so the second tap in the same frame gets
> `null` and returns. `log()` then uses the claimed local value throughout - the two remaining
> reads of `armed` in its body (the `ADD_EVENT` type and the spoken announcement) were also
> switched, since they would otherwise have used the stale closure value.
>
> Chosen over a time-based lockout because a threshold is arbitrary and would reject a genuine
> fast second action: once the stat is re-armed, the next tap is accepted however quickly it
> arrives. Verified by P4, which triple-taps one arming and double-taps the next and asserts
> exactly two logs.

**Severity:** MEDIUM
**Category:** Correctness / Mobile Reliability
**Location:** `src/screens/LiveGameScreen.tsx:272-293` (`log()`), `:452-456` (`PlayerChip` `onPress`)

**Evidence:** The only guard against double-logging a stat is `armed` flipping to `null` after the first tap, which requires a React re-render to actually disable the `Pressable`. There is no synchronous, ref-based lock.

**Impact:** Two touch events registered in very quick succession - a plausible "excited scorekeeper" double-tap, or a stutter on a lower-end device - can both read the pre-render `armed` value and both dispatch `ADD_EVENT`, double-counting a made shot, foul, or other stat.

**Recommendation:** Add a synchronous ref-based in-flight guard (e.g. `const loggingRef = useRef(false)`, checked and set at the top of `log()`, cleared after dispatch) so a second tap within the same synchronous window is ignored regardless of render timing.

**Confidence:** MEDIUM CONFIDENCE

---

### F-19: Duplicated ad hoc `setTimeout` retries for membership eventual consistency

**Severity:** MEDIUM
**Category:** Architecture / Reliability
**Location:** `src/screens/CreateLeagueScreen.tsx:26-28`, `src/screens/RecGameScreen.tsx:113`

**Evidence:** Both screens independently work around the same server-side eventual-consistency gap (an owner's `league_members` row not yet visible immediately after an RPC insert) with magic-number `setTimeout` chains (1200ms/3500ms in one screen, 1500ms in the other) calling `reloadMemberships()`.

**Impact:** Two independent, untuned guesses at the same underlying timing problem. On a slow network the guessed delays may still be too short, silently leaving `isOwner`/`canScore` false and hiding admin controls until the next reload; on a fast network they are wasted round trips. Any future fix (retry-with-backoff, or awaiting the RPC's own confirmation) has to be applied in multiple places.

**Recommendation:** Extract a single shared `ensureMembershipVisible()` helper (in `AdminProvider` or a shared hook) that retries/polls with backoff, called from one place after any owner-creating mutation.

**Confidence:** HIGH CONFIDENCE

---

### F-20: Foul-out danger and other risk cues communicated by colour alone

**Severity:** MEDIUM
**Category:** Accessibility
**Location:** `src/screens/LiveGameScreen.tsx:607-646` (`PlayerChip` foul indicator), the same pattern in `SubModal`

**Evidence:** `const danger = fouls !== undefined && foulLimit !== undefined && fouls >= foulLimit - 1;` changes only the text colour of the foul count, with no accompanying icon, weight change, or textual warning.

**Impact:** Colourblind users scoring or substituting players (roughly 8% of men, for red-green deficiency) will not reliably notice a player is about to foul out from colour alone, which is safety/rules-relevant information during live play.

**Recommendation:** Add a non-colour cue (bold weight, a warning glyph, or parenthetical text) alongside the colour change when `danger` is true.

**Confidence:** HIGH CONFIDENCE

---

### F-21: Touch targets below guideline size on frequently-used live-game controls

**Severity:** MEDIUM
**Category:** Accessibility
**Location:** `src/screens/LiveGameScreen.tsx:574-588` (`MiniBtn` - Court/Log/Timeout/Undo/Redo/Subs), `src/components/ui.tsx:245-269` (`Segmented`)

**Evidence:** `MiniBtn` uses `paddingVertical: 7` with 13pt text and no `minHeight`, yielding an effective tap target of roughly 28-30px; `Segmented` (used for tab switching, the live-tracker sub-mode switch, and the box-score toggle) similarly yields roughly 32px. Both are well under the 44pt (iOS) / 48dp (Android) minimum guidance.

**Impact:** These controls, particularly Undo in `MiniBtn`, are tapped frequently during fast-paced live scoring, so undersized targets increase the chance of mis-taps that corrupt the stat log mid-game.

**Recommendation:** Increase `paddingVertical` or set an explicit `minHeight: 44` on both components, or add `hitSlop` to compensate without changing the visual footprint.

**Confidence:** CONFIRMED

---

### F-22: Stale documentation (README architecture list, TROUBLESHOOTING.md New Architecture claim)

**Severity:** MEDIUM
**Category:** Documentation
**Location:** `README.md` "Architecture" section; `TROUBLESHOOTING.md` ("This project ships with `newArchEnabled: false` - keep it that way for Expo Go")

**Evidence:** `README.md`'s screen list names 13 of the 19 files actually present under `src/screens/` - `BulkImportScreen`, `FinalScoreScreen`, `ManagePromosScreen`, `SeasonRecapScreen`, `ShareCardScreen`, and `TeamProfileScreen` are absent. Separately, `app.json` does not set `newArchEnabled` at all, and Expo SDK 53+ defaults this to `true` when omitted - so the app is very likely actually running with the New Architecture enabled, contradicting the troubleshooting doc's stated assumption.

**Impact:** A new contributor using the README to orient themselves will not know six real screens/features exist. A contributor debugging the documented "Opening project... hangs in Expo Go" issue using the stated premise (New Architecture is off) could rule out a plausible actual cause and waste time on networking-only theories.

**Recommendation:** Update the README screen list to reflect all 19 screens. Either explicitly set `"newArchEnabled": false` in `app.json` if that is the intended, tested configuration, or correct `TROUBLESHOOTING.md` to reflect the actual SDK-54 default.

**Confidence:** CONFIRMED (README staleness) / HIGH CONFIDENCE (New Architecture claim)

---

## Low Findings

### F-23: Duplicated image-picker and share/screenshot-fallback logic

**Severity:** LOW | **Category:** Code Quality
**Location:** `EditTeamScreen.tsx:68-87` vs `ManagePromosScreen.tsx:25-42` (near-identical permission-request -> pick -> base64 -> error-handling blocks); `SeasonRecapScreen.tsx:25-35` vs `ShareCardScreen.tsx:47-57` (near-identical capture -> `Sharing.isAvailableAsync` -> fallback-to-text-share blocks).
**Impact:** Non-trivial async/permission/error-handling logic duplicated verbatim; a future fix to either pattern (e.g. handling a permanently-denied permission, or changing the Expo Go fallback) has to be made in two places and can drift.
**Recommendation:** Extract `pickImageAsBase64Uri({ aspect, quality })` and `shareViewAsImage(ref, opts, textFallback)` helpers into `src/lib/`.
**Confidence:** HIGH CONFIDENCE

### F-24: Several small duplicated helpers

**Severity:** LOW | **Category:** Code Quality
**Location:** `ManagePromosScreen.tsx:12` reimplements `uid()` already exported from `src/lib/format.ts`; `src/lib/stats.ts:178` and `:213-215` independently implement the same "current team for a player" fallback rule; `EditTeamScreen.tsx:16-36` defines reusable colour-math (`hslToHex`, a 36-swatch shade grid, hex validation) at screen scope instead of in `theme.ts`/a shared module.
**Impact:** Minor duplication risk - a future change to any of these rules needs to be made in more than one place, and nothing enforces they stay in sync.
**Recommendation:** Reuse the shared `uid()`; extract a single `resolveTeamFor()` helper for the team-lookup fallback; move the colour utilities into `theme.ts` or a new `src/lib/color.ts`.
**Confidence:** HIGH CONFIDENCE

### F-25: Icon-only buttons and dense stat tables lack accessible labels/semantics

**Severity:** LOW | **Category:** Accessibility
**Location:** Play-by-play/box-score delete controls (`✕` glyph, no `accessibilityLabel`), the favourite-team `★`/`☆` toggle, `EditTeamScreen`'s colour `Swatch` buttons (no name/hex exposed); `BoxScoreScreen.tsx:429-481` and `LeagueDetailScreen.tsx:335-369`'s dense stat tables (each cell an unconnected `Text` node with no header association).
**Impact:** Screen readers announce icon-only controls as an unlabelled symbol or nothing meaningful; stat tables require swiping through dozens of disconnected values per row with no announced column context.
**Recommendation:** Add `accessibilityLabel` to each icon-only control; compose a per-row `accessibilityLabel` summarising each table row for screen readers.
**Confidence:** CONFIRMED (icon buttons) / MEDIUM CONFIDENCE (table semantics)

### F-26: "Best all-around game" is selected by points only

**Severity:** LOW | **Category:** Correctness
**Location:** `src/lib/stats.ts:325-344` (`careerStats` `bestGame`), labelled "BEST ALL-AROUND GAME" in `PlayerProfileScreen.tsx:156`
**Impact:** The label implies a composite measure, but selection is purely `pts`-based, even though the codebase already has `perfRating()` used elsewhere for exactly this kind of "best game" ranking (MVP/Player of the Game/awards). A genuinely well-rounded near-triple-double will never surface here if a higher-scoring, one-dimensional game exists.
**Recommendation:** Either rename the label to "Best scoring game," or select by `perfRating()` for consistency with the rest of the awards logic.
**Confidence:** HIGH CONFIDENCE

### F-27: Share card can present a 0-stat player as "Player of the Game"

> **Updated 29/08/2026. NOT A DEFECT.** Investigated for the fix and the reported behaviour does
> not occur. Every award card is already gated:
> `cardSpecs.ts` filters the Player-of-the-Game pool with `perfRating(l) > 0`, the Career High
> card requires `line.pts > 0 && line.pts >= c.highPts`, and the double/triple-double and 25-point
> cards need real thresholds. `FinalScoreScreen` filters its own pool the same way. `git log -S`
> shows those filters predate this remediation batch, so the audit's HIGH CONFIDENCE call was
> mistaken rather than fixed by adjacent work.
>
> `perfRating` of an all-zero line is exactly `0` (`pts + 1.2reb + 1.5ast + 3stl + 3blk - tov`), so
> `> 0` genuinely excludes a player who has done nothing, and a line with only a turnover is
> negative. The one card always offered is "Game Stat Line", which is a plain stat line rather than
> an award and is honest at 0.
>
> Rather than change nothing and move on, the property is now pinned: **Q6-Q10** assert the rating
> boundaries and that a 0-stat player in a fresh live game is offered `['line']` only, with no
> `potg` key. So if a future edit removes a gate, a test fails.

**Severity:** LOW | **Category:** Correctness
**Location:** `src/screens/BoxScoreScreen.tsx:59-63`
**Impact:** `teamBoxScore()` seeds every roster player with a 0-stat line before any events exist, and "Share box-score card" is available while a game is still live (not gated on any stats existing). At 0-0, `star` resolves to an arbitrary roster player with 0 of everything, and the generated share card would present them as "Player of the Game" if shared at that point.
**Recommendation:** Only populate the star-player section once the selected player has a non-zero combined stat line, or disable that section of the share card until then.
**Confidence:** HIGH CONFIDENCE

### F-28: Milestone-banner timers not cleared on unmount

**Severity:** LOW | **Category:** Mobile Reliability
**Location:** `src/screens/LiveGameScreen.tsx:163-175` (`showNextMilestone`)
**Impact:** Two chained `setTimeout` calls (2200ms then 350ms) are never cleared if the screen unmounts while a milestone banner is queued or showing - a real resource leak (though a benign no-op under React 19, not a crash), inconsistent with the careful cleanup used elsewhere in the same file (the "waited for teams/game" timers and the `beforeRemove` navigation listener all correctly clean up). Separately, milestone "celebrated" keys are never cleared, so undoing a threshold-crossing event and re-crossing it later produces no new celebration.
**Recommendation:** Store timeout ids in refs and clear them in a `useEffect` cleanup on unmount; consider clearing the relevant `celebratedRef` keys when `UNDO_EVENT` removes a threshold-crossing event.
**Confidence:** HIGH CONFIDENCE

### F-29: Verbose auth-flow logging ships in release builds

**Severity:** LOW | **Category:** Security (defence-in-depth)
**Location:** `src/store/AdminProvider.tsx:276` and numerous `console.warn` calls throughout the auth/sync paths
**Impact:** None of the currently-logged content is sensitive (the OAuth redirect URL is meant to be publicly registered; other logs are generic error messages), but nothing gates this behind `__DEV__` or strips it for release builds, so a future edit could accidentally log something sensitive without anyone noticing.
**Recommendation:** Gate diagnostic logs behind `if (__DEV__)`, and/or add a release-build console-stripping transform (e.g. `babel-plugin-transform-remove-console`, excluding `warn`/`error`) as defence in depth.
**Confidence:** HIGH CONFIDENCE

### F-30: `tsconfig.json` omits some relevant strictness flags

**Severity:** LOW | **Category:** Build Config
**Location:** `tsconfig.json`
**Impact:** `"strict": true` covers the core soundness flags, but `noUncheckedIndexedAccess` in particular is directly relevant to a concern the project already cares about enough to enforce at runtime: `tests/README.md` explicitly calls out "no non-null assertions on `.find()`" as a static check, which is exactly the class of bug `noUncheckedIndexedAccess` catches at compile time instead.
**Recommendation:** Enable `noUncheckedIndexedAccess` (highest value given the project's own stated concern) and `noFallthroughCasesInSwitch` (relevant to a reducer-heavy, switch-based state machine) incrementally, fixing resulting errors one flag at a time.
**Confidence:** MEDIUM CONFIDENCE

---

## Informational Findings

### F-31: `.gitignore` has no forward-looking patterns for future secret-bearing files

**Severity:** INFO | **Category:** Security
**Evidence:** `DEPLOYMENT.md` documents a future step creating a `play-service-account.json` file locally for Android submission, but `.gitignore` (5 patterns: `node_modules/`, `.expo/`, `dist/`, `*.log`, `.DS_Store`, `.env*`) has nothing that would catch it, an iOS provisioning profile, or a keystore if one is ever dropped in the repo root. No such file currently exists in the tree.
**Recommendation:** Add defensive patterns now (`*.p8`, `*.p12`, `*.jks`, `*.keystore`, `*.mobileprovision`, `play-service-account.json`, `google-services.json`, `GoogleService-Info.plist`) before any of these files are ever created.
**Confidence:** HIGH CONFIDENCE

### F-32: Positive findings

The following were actively checked and found to be in good shape, worth recording so they are not mistaken for unreviewed gaps:

- **Deep-link/OAuth handling is not exploitable as built.** `NavigationContainer` has no `linking` prop and there is no global `Linking.addEventListener` anywhere in `src/`; the only consumer of an incoming URL (`createSessionFromUrl`) is fed exclusively by the synchronous return value of an app-initiated `WebBrowser.openAuthSessionAsync` call, not by arbitrary externally-fired deep links. The theoretical OAuth-token-injection-via-deep-link risk this audit set out to check is not currently reachable.
- **No injection vectors found.** `rosterParse.ts` and other free-text input paths (team/player/coach names, promo fields) flow into Supabase exclusively via parameterised RPC calls or the query builder, never string-concatenated SQL; no `WebView` or `dangerouslySetInnerHTML` exists anywhere in the app, so there is no HTML-rendering surface for free-text data.
- **External URL handling is safe.** Admin-entered promo links are coerced to `https://` if they do not already start with `http(s)://`, which neutralises `javascript:`/custom-scheme injection risk before the URL is ever opened.
- **Keyboard handling is centralised and consistent.** The shared `Screen` component wraps every screen in a `KeyboardAvoidingView` with sensible platform-specific behaviour; all form-heavy screens checked use it correctly.
- **`lib/stats.ts` is a clean, side-effect-free derivation layer** with no React/UI imports (aside from one documented `Date.now()` read inside `bestInWindow`, flagged separately as a minor purity gap, not a bug).
- **`.env` itself is correctly gitignored and was never tracked** - confirmed via `git ls-files` and `git log --all -- .env`. The admin email allowlist is consistently mirrored across `AUTH_SETUP.md`, `AdminProvider.tsx`, and `schema.sql`.
- **The stat pad's make/miss distinction is not colour-only** - it pairs colour with a distinct label ("2PT" vs "2PT X") and a filled/outline armed state, which meaningfully reduces (though does not eliminate, see F-20) the app's colourblindness risk given it is explicitly a colour-coded design.
- **react 19.1.0 / react-native 0.81.5 / expo ^54.0.0 is a coherent, currently-supported combination** with no version mismatch.
- **The project's own regression suite is thorough and, when run, passes cleanly** (see Verification Performed) - 138 + 32 + 217 assertions with only 4 pre-existing, documented, accepted warnings.

**Confidence:** CONFIRMED

---

## Security Assessment

The security posture is a genuine mix of strong design and real hygiene lapses. The row-level security model in `supabase/schema.sql` is thoughtfully built: it correctly uses `security definer` functions to keep sensitive tables (`admin_secret`, `admin_attempts`, `creation_codes`) unreadable/unwritable via the API entirely, layers Super Admin / owner / scorekeeper / shared-community roles with per-row checks (`can_score_row`, `can_score_game`) rather than blanket table policies, and the admin-password backup path is deliberately hardened (bcrypt, constant-time comparison, a 5-attempt/15-minute lockout with a documented threat model explaining exactly why each control exists). Server-side enforcement is real, not merely client-side gating - `AdminProvider.tsx`'s `deriveRole()` centralises role computation in one place and every write path is backed by an RLS policy, not just a UI check.

Set against that: F-01 (a plaintext admin password permanently in git history from the initial commit, since remediated in code) and F-02 (a live Supabase URL/anon key tracked in a stray text file) are both real, confirmed lapses in secrets hygiene - notably, both stem from the same root cause of copying real configuration values into a file the project didn't intend to be tracked, rather than from a flaw in the security design itself. No other hardcoded secrets, injection vectors, or exploitable deep-link paths were found in this audit. `RECORD_AUDIO` (F-10) is a least-privilege concern rather than an active vulnerability.

## Data Integrity Assessment

The event-sourced, derive-don't-store model for box scores/standings is a sound design that avoids an entire class of "stats out of sync with the play-by-play" bugs by construction. The realtime-sync race conditions this pattern is exposed to (a stale server snapshot overwriting a just-made local write) are handled thoughtfully via the pending-writes ledger, the snapshot watermark and the single pull owner, and this is one of the few areas of the app with dedicated automated tests (the two-device sync suite) proving the guards actually work against a PostgREST-accurate emulator.

The one confirmed data-integrity defect found is F-04 (`DELETE_EVENT` failing to reverse a foul-out auto-bench) - a real, reachable inconsistency between two reducer cases that should behave identically for this side effect but do not. F-11 (ties recorded as home wins) and F-17 (a stale lineup snapshot in the substitution modal) are the other integrity-adjacent findings; none involve data loss, all are recoverable by a scorekeeper noticing and correcting manually, but none should require that.

## Testing Assessment

**Existing coverage is unusually good for a project this size** in the areas it targets: reducer/state-transition logic, the stats derivation engine, the roster parser, a genuinely adversarial two-device sync suite that models real PostgREST quirks (RLS as a silent filter, request-reordering races), and a set of static structural invariants that catch whole bug classes (dead routes, missing reducer cases, RPC/table drift against `schema.sql`, hard-coded password literals). All of it passes cleanly when actually run (see Verification Performed).

**What is explicitly and knowingly not covered** (per the project's own `tests/README.md`): rendering, navigation, gestures, native modules (share-card capture, haptics, image picker), and real Supabase/RLS behaviour against a live project. This audit's own findings land almost entirely in that uncovered territory - F-04, F-11, F-17, and F-18 are all reducer/UI-interaction bugs that the existing reducer suite's fixture-based tests did not happen to exercise (e.g. no test deletes a foul-out-causing event, or asserts tie-game standings behaviour), and the accessibility findings (F-05 through F-07, F-20, F-21, F-25) are entirely outside any current automated coverage.

**Critical missing coverage**, prioritised:
1. A reducer test asserting `DELETE_EVENT` on a foul-out-causing event restores the player to court (would have caught F-04).
2. A `standings()` test asserting tied-score behaviour is handled deliberately, not accidentally (would have caught F-11).
3. `rosterParse.ts` tests for digit-containing team names and back-to-back headers with no blank-line separator (would have caught F-12).
4. Any accessibility-focused testing at all - there is currently none, and the on-device gap (F-05 through F-07 especially) could only be found by code inspection in this audit, not confirmed by a running screen reader.

## CI/CD Assessment

> **Updated 28/08/2026.** Addressed on `chore/ci-and-windows-tests`, merged to `main` in PR #2.
> `.github/workflows/ci.yml` runs on `pull_request` and on pushes to `main`: a `verify` job
> (`npm ci`, then `node tests/run.js` against a `postgres:16-alpine` service with
> `ITALA_REQUIRE_DB=1`, covering the type check and all four suites plus the wired SQL suites,
> output kept as an artifact) and a `bundle` job (`npx expo export`, Metro plus Hermes).
> Linting is still absent (F-09) and is the recommended next addition. The workflow has now run on
> PRs #2-#7, but **its results cannot be read from this environment** (no `gh` CLI, private repo)
> - see the caveat in **Verification evidence**. The assessment below describes the state as
> audited.

**Current state:** one workflow, and it does not verify code - it only keeps a Supabase project from auto-pausing. There is no automated verification of any pull request.

**Missing, relative to what the project's own `tests/README.md` says should run:** type checking, the reducer/stats/parser suite, the two-device sync suite, static structural checks, the SQL suite, and (since no tooling exists for it at all - F-09) linting/formatting.

**Branch protection:** could not be verified or configured from this read-only audit (requires repository administration access not exercised here); given there is no CI to require in the first place, this is moot until F-03 is addressed.

**Deployment risk:** `DEPLOYMENT.md` is thorough and mostly accurate against the current configuration, with the staleness noted in F-22 (New Architecture claim) and a minor EAS CLI version-floor inconsistency (F-30 area, INFO-level, not separately numbered above) worth a quick correction pass.

## Architecture Assessment

**Strengths:** a single, well-documented reducer as the source of truth; a clean separation between the pure derivation layer (`lib/stats.ts`) and UI; centralised role/permission logic (`deriveRole()`, `canScore()`/`canScoreGame()`/`isOwner()`) that screens consume rather than reimplement; the sync layer's guard mechanisms are a genuinely sophisticated, well-reasoned solution to a hard problem (offline-first + realtime races).

**Weaknesses:** `src/components/ui.tsx` has grown into a "kitchen sink" (design-system primitives, brand components, full auth-modal flows, and promo widgets all in one 773-line file) which is a maintainability/merge-conflict concern rather than a functional bug (F-24 area). A few screens (`SelectLineupScreen`) have independently invented their own bespoke "wait for data to settle" pattern rather than reusing the store-level guard system, and the membership-eventual-consistency workaround (F-19) is duplicated with different magic numbers in two places. None of this rises above LOW/MEDIUM severity, and none of it contradicts the overall architecture, which is sound.

**Recommended incremental improvements:** split `ui.tsx` along its four natural seams (primitives / auth / promos / onboarding) if it grows further; consolidate the membership-visibility retry into one shared helper; consider whether `SelectLineupScreen`'s bespoke waiting logic should be generalised into a reusable hook.

## Mobile Reliability Assessment

App-backgrounding and termination safety during a live game is solid at the store level (autosave on every reducer change is the real safety net), and the screens checked in this audit correctly clean up their timers and listeners with two exceptions (F-28's milestone banner, and the related celebration-ratchet gap). Permission handling (photo library, notifications, Apple sign-in availability) is implemented defensively with reasonable fallbacks. `F-10` (`RECORD_AUDIO`) and `F-15` (unresized images) are the two concrete mobile-reliability gaps found; the double-tap risk on the stat pad (F-18) and the unbounded play-by-play list (F-16) are the two performance-adjacent reliability risks most relevant to the app's core, highest-pressure use case (fast live scoring).

## Performance Assessment

No confirmed, measured performance defects were found (nothing was profiled on-device in this audit), but several plausible, code-evidenced risks were identified and are reported as such rather than as confirmed problems: F-14 (whole-app-state-triggered recomputation in the live tracker), F-16 (unbounded play-by-play rendering), and F-15 (unbounded image payload size feeding both AsyncStorage autosave and Supabase sync traffic). All three concentrate on the same screen and the same underlying data path (the live game / its box score), which is also the app's most latency-sensitive surface, so they are worth prioritising together even though none is independently severe.

## Accessibility Assessment

> **Updated 28/08/2026.** Addressed on `feat/a11y-core`, not yet merged. F-05, F-06 and F-07 are
> implemented: `AccessibilityInfo.announceForAccessibility` on arm, log, timeout, undo, redo and
> the milestone banner; roles, labels and state on the shared `ui.tsx` primitives and on every
> bespoke control on `LiveGameScreen`; and a non-gesture "Delete game" accessibility action.
> `static.test.js` CHECK 14 guards the semantics.
>
> **F-20 and F-21 remain open**, and the crucial caveat stands: **no screen reader has been run
> against any of this.** Static checks prove the semantics exist, not that VoiceOver or TalkBack
> read them sensibly or in the right order. See `tests/MANUAL-REGRESSION.md` section P6. Until
> that pass is done, treat this category as implemented-but-unverified rather than closed.

This is the area with the largest gap between the app's actual quality elsewhere and its current state: there is effectively no accessibility support anywhere in the app (F-06), and the single most-used screen has no live-region feedback at all for its core two-tap interaction (F-05, CRITICAL) plus undersized touch targets on its most-tapped secondary controls (F-21) and colour-only risk indicators (F-20). The swipe-only game-deletion flow (F-07) is the one destructive action in the app with no accessible alternative. None of this is contradicted by any positive finding in this category - the one bright spot (F-32's note on the stat pad's non-colour-only make/miss distinction) is a partial mitigation, not a substitute for the missing roles and announcements. This should be treated as a first-class workstream, not a follow-up polish pass, given how central `LiveGameScreen` is to the app's entire purpose.

---

## Recommended Remediation Plan

> **This plan is the original 27/08/2026 recommendation, kept as written.** For what has actually
> been done since, which branch each fix is on, and what to pick up next, see
> **Remediation Progress** near the top of this document. Items below carry a status marker where
> the outcome differed from the recommendation.

### P0 - Immediate

> **Status (updated 28/08/2026): all three P0 items are closed.**
>
> Item 1 (F-01) **FIXED (risk accepted)** - see the risk acceptance under F-01 below.
> Item 2 (F-02) **FIXED** - `bpbl.txt` is gone from the tree and this repository's history, and the
> anon key it exposed has been rotated.
> Item 3 **DONE and merged** (PR #1).
>
> Note on evidence: both rotations happen in the Supabase dashboard and **cannot be verified from
> this repository**. These entries record the operator's confirmation, which is attestation rather
> than something the test suite proves.

**1. Confirm/complete the admin-password rotation and decide on git-history remediation (F-01).**
Problem: a plaintext admin password is permanently in git history from the initial commit. Solution: verify `set_admin_password()` was run on every project that used it; decide whether to rewrite history. Expected benefit: closes a credential-compromise risk that has likely already been substantially reduced by the code-level fix, but is not fully closed until rotation is confirmed. Risk of change: history rewriting requires a coordinated force-push; low risk if skipped in favour of rotation-only. Suggested tests: none needed beyond confirming `tests/sql/admin_secret.test.sql` still passes after any change.

**2. Remove `bpbl.txt` and rotate its Supabase anon key (F-02).**
Problem: live credentials tracked in git under a non-obvious filename. Solution: delete the file (and from history, ideally alongside item 1), regenerate the anon key in the Supabase dashboard, update the real `.env`. Expected benefit: removes a live, publicly-discoverable target reference. Risk of change: none functionally (the file is not read by the app); regenerating the key requires updating `.env` on all developer machines. Suggested tests: confirm the app still connects after the key rotation (`SYNC_ENABLED` path).

**3. Fix `DELETE_EVENT`'s foul-out desync (F-04).**
Problem: deleting a foul-out-causing event leaves a player stranded off-court. Solution: mirror `UNDO_EVENT`'s reversal logic. Expected benefit: closes a real, reachable data-integrity bug during live games. Risk of change: low, localised to one reducer case. Suggested tests: a reducer test that adds fouls to the limit, deletes the limit-crossing `'pf'` event, and asserts the player is restored to court (space permitting).

### P1 - High Priority

> **Status:** all four items implemented and **merged to `main`**. Item 4 **DONE**
> (`chore/ci-and-windows-tests`, PR #2), item 5 **DONE** but by a different mechanism than recommended
> (see "Where the original finding was incomplete or wrong"), item 6 **DONE in code** with the
> on-device screen-reader pass still outstanding (`feat/a11y-core`), item 7 **DONE** as a draw
> rather than a blocked finish, and it turned out to span five call sites rather than three
> (`fix/tied-scores`).

**4. Stand up a CI pipeline (F-03).**
Problem: no automated verification of PRs. Solution: add a GitHub Actions workflow running `tsc`, the existing `tests/run.js` suites, and ideally a build sanity check, on `push`/`pull_request`. Expected benefit: catches regressions before merge; makes CI the authoritative verification the project's own standards call for. Risk of change: low; may surface pre-existing flakiness once running regularly on a fresh runner each time. Suggested tests: the workflow run itself is the test.

**5. Fix `tests/run.js` on Windows (F-08).**
Problem: local verification is broken for Windows contributors. Solution: add `shell: true` (or resolve `npx.cmd` explicitly on `win32`) to the `execFileSync` calls. Expected benefit: removes an undocumented workaround requirement. Risk of change: very low, mechanical fix. Suggested tests: run `npm test` on Windows after the change.

**6. Add accessibility roles, labels, and live-region announcements to the core stat-entry flow (F-05, F-06, F-07).**
Problem: the app's primary interaction is effectively unusable with a screen reader. Solution: add `accessibilityRole`/`accessibilityState` to shared `ui.tsx` primitives (propagates broadly), add live-region announcements to `LiveGameScreen`'s arm/log flow, add a non-gesture fallback for game deletion. Expected benefit: closes the largest single gap found in this audit. Risk of change: low to moderate (touching a high-traffic screen); should be paired with on-device VoiceOver/TalkBack testing before considering it done. Suggested tests: manual on-device screen-reader walkthrough of logging a full possession (arm -> tap player -> confirm announcement); no existing automated coverage exists for this layer.

**7. Fix tied-score handling (F-11).**
Problem: ties silently recorded as home wins in three places. Solution: treat ties as draws (or block finishing on a tie) consistently across `stats.ts`, `BoxScoreScreen`, and `GamesOnDateScreen`. Expected benefit: correct standings/records. Risk of change: low; consider whether any existing recorded games in the wild are already affected and need a data correction pass. Suggested tests: a `standings()` test with a tied game asserting no win/loss is credited to either side (or that a `ties` column is incremented, depending on the chosen fix).

### P2 - Medium Priority

**8.** Add ESLint/Prettier and wire into CI (F-09). - **PARTIAL.** ESLint is in place (`eslint.config.js` on `eslint-config-expo` 10.x, matched to SDK 54) with `npm run lint` gating a dedicated CI job, and all 59 initial violations were fixed rather than suppressed - which surfaced one genuine crash (N-11) and three smaller defects (N-07, N-12, N-13). Prettier is installed and configured with `npm run format` / `format:check`, but is **not applied and not gated**: it would rewrite all 54 files, which is a mechanical commit of its own. One rule was deliberately relaxed - `react/no-unescaped-entities`, which is an HTML concern that does not apply to RN `<Text>` - and one deliberately left as a warning, `react-hooks/exhaustive-deps`, whose only two hits are F-14.
**9.** Remove or justify the `RECORD_AUDIO` permission (F-10). - **DONE, differently.** The permission does not come from `app.json`; `expo-image-picker`'s config plugin adds it. Fixed with `microphonePermission: false` / `cameraPermission: false`, which also blocks `CAMERA`.
**10.** Fix `rosterParse.ts` header-detection edge cases (F-12), with accompanying parser tests.
**11.** Run `npm audit fix` for the non-breaking subset; schedule the `expo@57` migration deliberately (F-13).
**12.** Scope `LiveGameScreen`'s `useMemo`/`useEffect` dependencies to the current game, not the whole app state (F-14).
**13.** Add image resizing before base64 encoding for team logos and promo images (F-15).
**14.** Virtualise the play-by-play list (F-16).
**15.** Resync the substitution modal's lineup snapshot (F-17); add a double-tap lock to the stat pad (F-18).
**16.** Consolidate the duplicated membership-visibility retry logic (F-19).
**17.** Add non-colour cues for foul-out danger and other risk indicators (F-20); enlarge undersized touch targets (F-21).
**18.** Update README's screen list and correct the `TROUBLESHOOTING.md` New Architecture claim (F-22). - **DONE.** All 19 screens plus every `lib`/`sync`/`components` module now listed, and the New Architecture claim corrected against `expo config --type introspect`, which reports `RCTNewArchEnabled: true`.

### P3 - Improvement

**19.** Deduplicate image-picker and share-fallback logic into shared helpers (F-23); consolidate the other small duplicated helpers (F-24). - **F-24 PARTIAL.** The duplicated winner check is centralised as `outcomeOf()` in `src/lib/stats.ts`; `uid()`, the team-resolution fallback and the colour helpers are untouched.
**20.** Add accessible labels to icon-only buttons and improve stat-table screen-reader semantics (F-25). - **PARTIAL.** The shared `ui.tsx` primitives and every control on `LiveGameScreen` are done; the other screens have not been swept, and the box-score table still has no table semantics.
**21.** Correct or rename the "best all-around game" label (F-26); gate the share card's "Player of the Game" section on non-zero stats (F-27). - **Both still OPEN**, but note the F-11 work changed adjacent code: Player of the Game now considers both teams on a drawn game (see N-04). The zero-stat gate is a separate change.
**22.** Clean up the milestone-banner timer leak and celebration-ratchet gap (F-28).
**23.** Gate diagnostic auth-flow logging behind `__DEV__` (F-29).
**24.** Incrementally enable `noUncheckedIndexedAccess` and `noFallthroughCasesInSwitch` in `tsconfig.json` (F-30).
**25.** Add forward-looking `.gitignore` patterns for keystores/service-account files (F-31).

---

## Recommended Testing Strategy

**Unit tests (extend the existing reducer/stats suite):**
- `DELETE_EVENT` foul-out reversal (directly closes the gap that let F-04 through).
- `standings()` tied-score behaviour.
- `rosterParse()` against digit-containing team names and back-to-back headers with no blank separator.
- `careerStats().bestGame` selection criterion, once F-26 is resolved, to lock in the intended behaviour.

**Integration tests:** the existing two-device sync suite is already strong; extend it to cover a substitution-modal-style scenario (a lineup write racing a foul-out auto-bench from a different device) to guard against regressions once F-17 is fixed.

**UI/component tests:** currently none exist at this level for the RN component tree itself (the project relies on the static structural checks instead, which is a reasonable choice for this codebase's size, but does not substitute for interaction testing). If component testing is added, prioritise `LiveGameScreen`'s arm/log/undo flow and the `SubModal`.

**Accessibility tests:** none currently exist. At minimum, add a manual on-device VoiceOver/TalkBack test script to `tests/MANUAL-REGRESSION.md` covering: logging a stat via the two-tap flow, deleting a game, and reading a box score - all currently identified as broken or degraded in this audit.

**E2E tests:** none currently exist; not necessarily required given the app's offline-first, mostly-local nature and the strength of the existing reducer/sync suites, but if introduced, the highest-value candidate journeys are: create a league -> add teams/players -> run a full live game start-to-finish -> view the resulting box score/standings, and the Google/Apple sign-in -> admin-elevation flow.

**Regression tests:** every P0/P1 fix above should ship with a regression test per the project's own CLAUDE.md standard (§8) - this audit has identified the specific gaps; closing them is a natural extension of the existing, already-strong reducer/stats/sync suites rather than a new testing effort.

---

## Recommended CI Strategy

A single `.github/workflows/ci.yml`, triggered on `pull_request` and `push` to `main`:

1. Checkout, `actions/setup-node` with npm cache enabled, `npm ci`.
2. `npx tsc --noEmit`.
3. `node tests/run.js` (once F-08 is fixed, this can run unmodified; until then, either fix F-08 first or invoke the equivalent steps directly in the workflow, since Linux runners are unaffected by the Windows-specific bug either way).
4. Optionally, a `postgres:` service container so the SQL suite (`tests/sql/run.js`) runs in CI instead of being silently skipped, closing the "Not Run" gap noted in this audit's own Verification Performed section.
5. Once F-09 lands, add `npm run lint` and `npm run format:check` steps.
6. A build sanity step (`npx expo export` or `expo prebuild --no-install`) to catch configuration-level breakage that `tsc`/tests would not.

Mark the workflow as a required status check on `main` via branch protection once it is green, per CLAUDE.md §16 (branch protection could not be configured or verified from this read-only audit - repository administration access was not exercised).

---

## Technical Debt

Prioritised, not exhaustive:

1. **Dependency staleness** (F-13/F-14 area) - every dependency is behind latest, with the `expo@57` migration already anticipated in `DEPLOYMENT.md` as the major piece of debt. Not urgent in isolation, but it is the root cause of most of the `npm audit` findings, so deferring it compounds that separate concern.
2. **`ui.tsx`'s low cohesion** - a natural split point (primitives / auth / promos / onboarding) exists and should be taken before the file grows further.
3. **Ad hoc timing workarounds** (F-19, and `SelectLineupScreen`'s bespoke waiting logic) - three different screen-local patterns exist for "wait for eventually-consistent server state," where the project already has a more principled guard mechanism at the store layer that two of the three don't use.
4. **No accessibility foundation** - this is large enough, and concentrated enough in the app's core screen, that it is better treated as a dedicated workstream (per the Recommended Remediation Plan's P1 items) than incremental technical debt.

---

## Unknowns / Unverified Areas

> **Still current as of 28/08/2026.** Remediation did not clear any of these. No Postgres, no
> device and no EAS build were available then either, and the dev machine additionally ran out of
> disk, so no bundle or prebuild verification happened. The first three items below are now
> tracked as concrete next steps in **Remediation Progress → Resume here**.

- **Whether the leaked admin password (F-01) was rotated on any live Supabase project.** No database access was available or sought in this read-only audit; this must be confirmed by someone with access to the actual deployed project(s).
- **SQL-level RLS/RPC tests (`tests/sql/`).** Skipped cleanly (by the suite's own design) because no local Postgres server was available in this environment. These tests are designed to run against a real Postgres and were not executed as part of this audit's verification.
- **On-device behaviour.** No emulator, simulator, or physical device was available in this environment. All mobile-reliability, performance, and accessibility findings are based on code inspection and documented platform behaviour, not on-device observation or profiling - this is explicitly flagged per finding above (see individual Confidence levels) rather than presented as measured fact.
- **Native build success (EAS build).** Not attempted; requires credentials and services outside the scope of a read-only audit.
- **Whether the repository is public or access-restricted on GitHub.** This materially affects the real-world exposure of F-01 and F-02; it was not checked as part of this audit and should be confirmed by the repository owner.
- **Whether other collaborators have local clones/forks predating any history rewrite**, which would limit how effective a `git filter-repo`/BFG pass could be at fully containing F-01/F-02's exposure.
