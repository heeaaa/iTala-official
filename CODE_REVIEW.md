# Code Review

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

---

## Application Overview

**Technology stack:** Expo SDK 54, React Native 0.81.5, React 19.1.0, TypeScript 5.9 (strict mode), React Navigation (native-stack), optional Supabase (`@supabase/supabase-js` ^2.45) with AsyncStorage as the local persistence layer.

**Architecture:** A single `useReducer`-based store (`src/store/StoreProvider.tsx`) is the source of truth for all UI state. Every dispatched action is: (1) applied to the reducer immediately (offline-first, always works), (2) autosaved to AsyncStorage on every change (`src/store/storage.ts`), and (3) if Supabase sync is configured (both `EXPO_PUBLIC_SUPABASE_URL`/`EXPO_PUBLIC_SUPABASE_ANON_KEY` env vars set), mirrored to Postgres via `src/sync/sync.ts`'s `pushAction`, serialized through a promise chain (`src/sync/pushQueue.ts`) to preserve dispatch order across the network. A Supabase Realtime subscription triggers a full-state re-pull (`HYDRATE`) when any row changes elsewhere. Because a full re-pull can race a just-made local write, the store layers three time-boxed "guards" (`lineupGuard`, `bundleGuard`, `undoGuard`) that protect recent local writes from being clobbered by a stale incoming snapshot - this is one of the more sophisticated and well-tested parts of the codebase.

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

**Progress last updated:** 28/08/2026. Original audit: 27/08/2026.

Status values used in the Findings Summary below:

| Status | Means |
|---|---|
| `FIXED (merged)` | On `main`. Done. |
| `FIXED (PR)` | Implemented, pushed, PR open, **not merged**. |
| `PARTIAL` | Partly addressed, or fixed in code but with an unverified step outside the repo. |
| `OPEN` | Not started. |

Counts: **10 fixed** (all merged), **5 partial**, **16 open**, 1 informational.
All P0 and P1 items are addressed, and **no CRITICAL or HIGH finding remains open**. P2 and P3 are
largely untouched: of the 16 open findings, 10 are MEDIUM and 6 are LOW.

> The previous revision of this section read "11 fixed ... 15 open". That was an arithmetic slip,
> not a change in scope - the table has always held 31 numbered findings plus F-32. The counts
> above are generated from the Findings Summary table rather than tallied by hand.

### Branch map

Every branch was a sibling built on `chore/ci-and-windows-tests` and merged in that order, so each
PR showed only its own changes against `main` and picked up CI. **All seven are now merged and
`main` (`477c891`) contains every one of them.** The table is kept for traceability.

| Branch | Findings | State |
|---|---|---|
| `fix/delete-event-foulout` | F-04 | Merged (PR #1) |
| `chore/ci-and-windows-tests` | F-03, F-08, N-01, N-02 | Merged (PR #2) |
| `fix/tied-scores` | F-11, N-03, N-04 | Merged (PR #3) |
| `feat/a11y-core` | F-05, F-06, F-07 | Merged (PR #4) |
| `refactor/remove-legacy-global-settings` | N-06, and docs for the `person_id` decision | Merged (PR #5) |
| `docs/review-progress-tracking` | F-22, this section | Merged (PR #6) |
| `chore/store-compliance-and-privacy-policy` | F-10, N-05, N-10 | Merged (PR #7) |

The sibling-stacking approach worked, but it cost one real incident: see **N-10**. Stacking
branches means every one of them carries a merge of `main`, and a merge resolution is a hand edit
that no reviewer diffs as carefully as a code change.

### Resume here

Steps 1 and 2 of the original list are **discharged**:

- Every branch is merged; `.github/workflows/ci.yml` has run.
- `supabase/schema.sql` was applied to the live project on **28/08/2026**, so the `track_misses`
  backfill ran while `app_settings` still existed and before any client without the legacy global
  reached users. That was the only hard ordering constraint in the batch.

What is actually left, in order of consequence:

1. **Confirm the two credential rotations** (F-01, F-02). Both are `PARTIAL` only because rotation
   happens in the Supabase dashboard and cannot be verified from the repo. If the old anon key
   still works, removing it from git history achieved nothing.
2. **Fill in the privacy policy placeholders** (`[OPERATOR]`, `[CONTACT EMAIL]`) and deploy the
   site (see `site/README.md`), then paste the URL into both store listings. The policy ships with
   a deliberate visible notice, so it cannot be published half-finished by accident.
3. **Do the on-device screen-reader pass** for F-05/F-06/F-07 (`tests/MANUAL-REGRESSION.md`
   section P6). This is the largest untested surface in the batch: the semantics are in place and
   guarded by CHECK 14, but nothing has confirmed a real screen reader reads them sensibly.
4. Then P2, starting with **F-09 (ESLint/Prettier)** since CI is the natural place to enforce it
   and every later change benefits.

### Environment constraints hit during remediation

Worth knowing before you assume something is broken:

- **`psql` is not installed on the dev machine**, and neither is Docker, so `tests/sql/run.js`
  skips locally. The two `settings_backfill` suites have therefore **never run on this machine**;
  CI is their only execution. What *can* be checked without a database is that every
  `schema.sql` slice anchor still resolves and every suite's `@requires` names a real section -
  that was verified after the PR #7 merge, since a moved anchor makes the runner throw.
- **The `C:` drive was full** during the first pass (0 bytes free at one point), which is why the
  earlier revision of this document recorded no local bundle verification. Space was freed
  afterwards and `npx expo export --platform android` has since completed cleanly (exit 0,
  3.63 MB Hermes bundle), so the CI `bundle` job's command is known to work on this tree.
- **The `gh` CLI is not installed**, so PRs cannot be opened and **CI status cannot be read from
  the shell**. The repository is private, so the unauthenticated GitHub REST API returns 404 as
  well. CI results have to be checked in the browser, and **nothing in this document may record a
  CI run as passing on any other basis**.

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
| N-07 | LOW | `tests/run.js` imports `execSync` and never uses it. | OPEN |
| N-08 | INFO | `src/screens/LiveGameScreen.tsx` uses `[state, leagueId, gameId]` as a `useMemo` dependency, so the box score recomputes on any app-wide state change. This is F-14, confirmed in passing while working in the file. | OPEN (see F-14) |
| N-09 | INFO | `showNextMilestone` in `LiveGameScreen` schedules `setTimeout` with no unmount cleanup. This is F-28, confirmed in passing. | OPEN (see F-28) |
| N-10 | HIGH | Merge `62fb42b` (`main` into `chore/store-compliance-and-privacy-policy`) resolved its only conflict by concatenating both sides of `tests/static.test.js` but dropping the `}` closing CHECK 15 and the `// ---` separator opening CHECK 14. The file stopped parsing (`TS1005`, then `SyntaxError: Unexpected end of input`), so `node tests/run.js` failed twice and **the static suite ran zero checks** - including the CHECK 15 assertions that this very branch added to guard the store declarations and the privacy policy. Fixed forward in `ef766b2`; the resolution was then verified to be the exact union of both parents, not merely parseable. | FIXED (merged) |

### Verification evidence

`npm test` runs the type check plus the reducer/stats/parser, two-device sync and static
structural suites, then the SQL suites.

**Current state of `main` (`477c891`, all seven PRs merged), run 28/08/2026:**

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

GitHub Actions          NOT VERIFIABLE HERE - no gh CLI, and the repo is private so the
                        unauthenticated REST API 404s. Check runs must be read in the browser.
                        Do not record a CI result in this document from any other source.
SQL settings_backfill   NOT RUN locally - no psql and no Docker on the dev machine. CI is their
                        only execution; PR #7's run is the first. Only the anchor resolution
                        above was checked locally, not the assertions.
On-device screen reader NOT RUN - no device or emulator available
Prebuild / built APK    NOT RUN - manifest verified by introspection only
```

**Applied to the live Supabase project:** `supabase/schema.sql` was re-run successfully on
28/08/2026, which is what discharges the ordering constraint in **Resume here**. The migration's
own assertions were *not* observed - the `settings_backfill` suites need a local Postgres - so what
is confirmed is that the script applied without error, not that the backfill produced the intended
per-league values. If that matters, query `leagues.track_misses` on the live project directly.

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
| F-01 | CRITICAL | Security | Plaintext admin password committed to git history in the initial commit | CONFIRMED | PARTIAL |
| F-02 | HIGH | Security / Data Integrity | Live production Supabase URL + anon key tracked in git (`bpbl.txt`) | CONFIRMED | PARTIAL |
| F-03 | HIGH | CI/CD | No CI pipeline runs tests, lint, type-check, or build on PRs | CONFIRMED | FIXED (merged) |
| F-04 | HIGH | Correctness / Data Integrity | `DELETE_EVENT` doesn't reverse foul-out auto-bench, unlike `UNDO_EVENT` | CONFIRMED | FIXED (merged) |
| F-05 | CRITICAL | Accessibility | Live two-tap stat entry has no screen-reader announcements (no live regions) | CONFIRMED | FIXED (merged) |
| F-06 | HIGH | Accessibility | No accessibility roles/labels anywhere in the app, including the stat pad | CONFIRMED | FIXED (merged) |
| F-07 | HIGH | Accessibility | Game deletion is swipe-gesture-only, with no non-gesture fallback | HIGH CONFIDENCE | FIXED (merged) |
| F-08 | MEDIUM | CI/CD / Testing | `tests/run.js` cannot run natively on Windows (`execFileSync('npx')` ENOENT) | CONFIRMED | FIXED (merged) |
| F-09 | MEDIUM | CI/CD | No ESLint/Prettier configuration exists anywhere in the project | CONFIRMED | OPEN |
| F-10 | MEDIUM | Mobile / Security | Unused, unexplained `RECORD_AUDIO` Android permission | CONFIRMED | FIXED (merged) |
| F-11 | MEDIUM | Correctness | Tied final scores are silently recorded as home-team wins | CONFIRMED | FIXED (merged) |
| F-12 | MEDIUM | Correctness | `rosterParse.ts` misparses team names/headers under common real-world paste shapes | HIGH CONFIDENCE | OPEN |
| F-13 | MEDIUM | Dependency | `npm audit`: 24 vulnerabilities in Expo/Metro build tooling (dev-time only) | CONFIRMED | OPEN |
| F-14 | MEDIUM | Performance | `LiveGameScreen` recomputes box score/milestones on unrelated app-wide state changes | HIGH CONFIDENCE | OPEN |
| F-15 | MEDIUM | Mobile / Performance | Team logo / promo images stored as base64 with no resize step, only quality compression | HIGH CONFIDENCE | OPEN |
| F-16 | MEDIUM | Performance | Unbounded play-by-play list rendered without virtualisation | MEDIUM CONFIDENCE | OPEN |
| F-17 | MEDIUM | Correctness / Concurrency | Substitution modal's "Set 5" lineup snapshot goes stale if state changes while open | MEDIUM CONFIDENCE | OPEN |
| F-18 | MEDIUM | Correctness / Mobile | No rapid double-tap lock on the live stat pad | MEDIUM CONFIDENCE | OPEN |
| F-19 | MEDIUM | Architecture | Duplicated ad hoc `setTimeout` retries for membership-row eventual consistency | HIGH CONFIDENCE | OPEN |
| F-20 | MEDIUM | Accessibility | Foul-out danger and other risk cues communicated by colour alone | HIGH CONFIDENCE | PARTIAL |
| F-21 | MEDIUM | Accessibility | Touch targets below guideline size on frequently-used live-game controls | CONFIRMED | OPEN |
| F-22 | MEDIUM | Documentation | README architecture list is stale (missing 6 of 19 screens); troubleshooting doc's New Architecture claim is stale | CONFIRMED / HIGH CONFIDENCE | FIXED (merged) |
| F-23 | LOW | Code Quality | Duplicated image-picker and share/screenshot-fallback logic across screens | HIGH CONFIDENCE | OPEN |
| F-24 | LOW | Code Quality | Several small duplicated helpers (`uid()`, team-resolution fallback, colour utilities embedded in a screen) | HIGH CONFIDENCE | PARTIAL |
| F-25 | LOW | Accessibility | Icon-only buttons and dense stat tables lack accessible labels/semantics | CONFIRMED / MEDIUM CONFIDENCE | PARTIAL |
| F-26 | LOW | Correctness | "Best all-around game" is selected by points only, not the existing composite rating | HIGH CONFIDENCE | OPEN |
| F-27 | LOW | Correctness | Share card can present a 0-stat player as "Player of the Game" at the start of a live game | HIGH CONFIDENCE | OPEN |
| F-28 | LOW | Mobile Reliability | Milestone-banner timers not cleared on `LiveGameScreen` unmount | HIGH CONFIDENCE | OPEN |
| F-29 | LOW | Security | Verbose, unconditional auth-flow console logging ships in release builds | HIGH CONFIDENCE | OPEN |
| F-30 | LOW | Build Config | `tsconfig.json` omits `noUncheckedIndexedAccess`, relevant to the project's own documented `.find()` concerns | MEDIUM CONFIDENCE | OPEN |
| F-31 | INFO | Security | `.gitignore` has no forward-looking patterns for keystores/service-account JSON that `DEPLOYMENT.md` instructs creating later | HIGH CONFIDENCE | FIXED |
| F-32 | INFO | Various | Positive findings (see below) | CONFIRMED | n/a |

---

## Critical Findings

### F-01: Plaintext admin password committed to git history

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

**Severity:** MEDIUM
**Category:** Correctness / Concurrency
**Location:** `src/screens/LiveGameScreen.tsx:654-655` (`SubModal`)

**Evidence:** `const [selected, setSelected] = useState<string[]>(onCourtIds);` captures the on-court lineup once at modal-mount time and never resyncs while the modal stays open.

**Impact:** If the on-court lineup changes underneath the modal while it is open - a realtime sync update from another device/scorekeeper, or an `ADD_EVENT` foul-out auto-benching a player - tapping "Confirm lineup" dispatches `SET_LINEUP` built from the stale snapshot, silently reverting the concurrent change (e.g. bringing back a just-fouled-out player, or dropping one just added elsewhere). This is exactly the class of race the project is otherwise careful about (see the documented `lineupGuard`/`bundleGuard` mechanisms at the store layer).

**Recommendation:** Reseed `selected` from `onCourtIds` via a `useEffect` keyed on `onCourtIds` (guarded against clobbering in-progress user taps), or diff against the latest `onCourtIds` at confirm time rather than trusting the mount-time snapshot.

**Confidence:** MEDIUM CONFIDENCE

---

### F-18: No rapid double-tap lock on the live stat pad

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

The event-sourced, derive-don't-store model for box scores/standings is a sound design that avoids an entire class of "stats out of sync with the play-by-play" bugs by construction. The realtime-sync race conditions this pattern is exposed to (a stale server snapshot overwriting a just-made local write) are handled thoughtfully via the `lineupGuard`/`bundleGuard`/`undoGuard` mechanisms, and this is one of the few areas of the app with dedicated automated tests (the two-device sync suite) proving the guards actually work against a PostgREST-accurate emulator.

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

> **Status:** item 1 **PARTIAL** (history rewritten; rotation not verifiable from the repo),
> item 2 **PARTIAL** (`bpbl.txt` gone from tree and history; anon-key rotation not verifiable),
> item 3 **DONE and merged** (PR #1).

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

**8.** Add ESLint/Prettier and wire into CI (F-09). - **OPEN, and now the next item of work.** Recommended as the first P2 item now that CI exists and every P0/P1 fix is merged.
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
