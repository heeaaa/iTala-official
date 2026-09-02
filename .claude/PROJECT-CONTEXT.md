# iTala agent context

This is the shared, repository-specific map for the agents in `.claude/agents/`.
It is a navigation aid, not a substitute for reading the current source. Code,
tests, schema, and `CLAUDE.md` remain authoritative.

## Product and runtime

- Expo SDK 54 / React Native 0.81 / React 19 mobile application.
- TypeScript is strict. Navigation uses React Navigation native stack.
- Supabase supplies authentication, PostgREST data access, realtime updates,
  RPCs, and the RLS-enforced server boundary.
- AsyncStorage keeps the local application snapshot and local preferences.
- The app records basketball events; box scores, standings, leaders, and career
  totals are derived from the event log rather than persisted as totals.
- `site/` is a separate static marketing/privacy site, not the mobile runtime.

## Architecture map

| Area | Authoritative locations | Notes |
| --- | --- | --- |
| App composition | `App.tsx`, `src/navigation.ts` | Providers wrap one native stack. Route declarations and registrations must agree. |
| Domain model | `src/types.ts` | League contains teams, players, games, events, and settings. |
| State and mutations | `src/store/StoreProvider.tsx` | Reducer is the local source of truth; dispatch also persists and mirrors writes. |
| Local persistence | `src/store/storage.ts` | AsyncStorage keys `hoops.state.v1` and `hoops.prefs.v1`. Existing installed data must remain readable. |
| Authentication/admin | `src/store/AdminProvider.tsx`, `src/store/authErrors.ts` | Client roles improve UX; Supabase RLS is the authorization boundary. |
| Server sync | `src/sync/sync.ts`, `src/sync/supabase.ts` | `pushAction` mirrors reducer actions and `fetchAllState` reads snapshots. |
| Ordering | `src/sync/pushQueue.ts` | Server mutations are serialized so later deletes/updates cannot overtake earlier inserts. |
| Reconciliation | `src/sync/pendingEvents.ts` | Pending ledger and snapshot watermark protect unsent/newer local changes from stale hydration. |
| Live input | `src/screens/LiveGameScreen.tsx`, `src/lib/liveInput.ts` | Highest-risk, latency-sensitive two-tap scoring path with duplicate-tap and lineup safeguards. |
| Derived statistics | `src/lib/stats.ts` | Totals are derived from events. Do not introduce a second persisted source of truth. |
| Shared UI | `src/components/ui.tsx` | High blast radius: enumerate consumers before changing primitives. |
| Database/security | `supabase/schema.sql` | Tables, functions, grants, constraints, and RLS policies must match client calls. |
| Regression tests | `tests/reducer.test.js`, `tests/sync.test.js`, `tests/static.test.js` | Custom dependency-light Node harness. |
| Database tests | `tests/sql/`, `tests/sql/run.js` | Skips without PostgreSQL locally unless `ITALA_REQUIRE_DB=1`. CI requires it. |
| Device QA | `tests/MANUAL-REGRESSION.md` | Rendering, gestures, native modules, screen readers, and real device lifecycle need manual evidence. |
| Historical decisions | `docs/CODE_REVIEW.md` | Check remediation status and do not re-raise accepted/resolved findings as new. |

## Critical invariants

1. `reducer` can run more than once for one user action. IDs and timestamps must
   be resolved by `stampActionIds` before reduction. Reducer cases must stay
   deterministic: no `Date.now()`, random IDs, I/O, or mutable external state.
2. A mutating action normally has three destinations: reducer state, AsyncStorage
   through the provider autosave, and Supabase through `pushAction`. Adding only
   one or two creates disappearing or cross-device-inconsistent data.
3. Server pushes must go through `enqueuePush`. A direct concurrent push can let
   an undo/delete overtake the insert it targets.
4. A server snapshot may be older than an on-device action. Every remote hydrate
   must carry the tick captured before its fetch and reconcile both events and
   game rows through the pending ledger.
5. Pulls have one owner in `StoreProvider`. A request arriving during an active
   pull queues a trailing pull; it must not create an uncoordinated fetch race.
6. A Supabase/PostgREST call can resolve with `res.error` on network failure.
   `try/catch` alone is not evidence that offline failure is handled. Inspect the
   returned error and the `check` versus `checkCritical` choice.
7. The fake Supabase test harness throws in its network failure mode, while the
   installed production client may resolve with an error object. A green fake
   test does not by itself prove production error propagation.
8. Stats are derived from the append-only event log. Do not store duplicate
   score/stat totals without an explicit migration and consistency design.
9. Client role checks are not authorization. Inspect `supabase/schema.sql` RLS,
   grants, RPC ownership, and affected-row verification for security-sensitive
   changes. RLS-hidden deletes can appear successful while removing no rows.
10. Existing installs and mixed client versions are normal. Preserve old
    AsyncStorage data, existing server rows, and backward-compatible contracts.

## Validation commands

Use the narrowest relevant command first, then broaden as risk warrants.

```text
node .claude/scripts/validate-agent-system.mjs  # agent-system structure
npm test                                        # typecheck + app suites; SQL may skip locally
npm run lint                                    # ESLint
npm run format:check                            # whole repo is not yet Prettier-clean; scope carefully
npx expo export --platform android --output-dir dist  # Metro/Hermes bundle evidence
```

`tests/run.js` reports its own pass/fail counts. Never turn a skipped database
suite into a pass. For database-authoritative evidence, run with PostgreSQL and
`ITALA_REQUIRE_DB=1`, as CI does.

## Risk routing

- State action, disappearing data, undo/redo, refresh, or cross-device issue:
  `debugger` plus `offline-specialist`; involve `test-engineer`.
- New feature or cross-layer change: `architect` before implementation.
- UI or interaction change: `mobile-qa`; update manual regression coverage when
  automation cannot exercise it.
- Auth, admin, membership, RPC, schema, or data exposure: `security-reviewer`.
- Large list, render, image, storage, or network-volume concern:
  `performance-reviewer`, with measurement or a reproducible proxy.
- Behaviour-preserving cleanup: `refactorer`; stop if behaviour must change.
- Merge decision: `pr-reviewer`, which stays read-only.

## Evidence standard

- Separate `PASS`, `FAIL`, `NOT RUN`, and `NOT APPLICABLE`.
- Name exact commands executed and relevant counts/output.
- Source inspection is evidence about code shape, not runtime behaviour.
- A test in the fake harness is not evidence about a real device, native module,
  real network transition, or production RLS unless that boundary was exercised.
- Report uncertainty and the cheapest next verification that would resolve it.
