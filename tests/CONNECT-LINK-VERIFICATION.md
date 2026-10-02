# Connect status regression evidence

Verified locally on 1 October 2026 on `codex/schedule-iphone-fixes`, extending
`80bb143`. The earlier combined UI fixes remain on this branch; their responsive
layout coverage and native limitations are in
[`UI-FIXES-VERIFICATION.md`](UI-FIXES-VERIFICATION.md).
Connect's paired implementation is on `codex/synced-connect-links`.

## Reproduced defects

1. Ordinary game starts previously discovered Connect links. With Connect
   unavailable, that request failed and the existing handlers showed an error.
   `node tests/connectLinkState.test.js --baseline` executes the actual module
   at `80bb143` and fails on the first ordinary-game action. The same suite
   against current code passes: twelve repeated policy checks make zero requests.
2. A known linked league with no saved schedule stopped loading if discovery
   failed. The added `scheduleCache.test.js` regression failed with `0 !== 1`
   schedule reads before the fix, then passed after the screen was changed to
   use the known event independently of discovery.
3. An older bridge returns HTTP 400 for `refreshLinks`. The native transport
   regression simulates that response, verifies legacy discovery succeeds at
   revision zero, and proves that hint cannot erase a newer server revision.
4. An older fresh schedule cache did not populate the new league setting.
   Its regression failed with `0 !== 1` updates before the fix and passed
   afterward, without a discovery request. Malformed cached revisions are rejected.

These controlled failures exercise shipped code, not the user's device network
or hosted configuration. They do not establish the exact hosted cause of a
specific screenshot.

## Executed checks

| Check | Result and scope |
| --- | --- |
| `node tests/run.js` | Passed, including TypeScript; 357 reducer, 488 sync, 120 provider and 891 static checks, plus feature suites. Two pre-existing positional-row warnings remain. |
| `connectStartUi.test.js` | Actual Start Game, New Game, Tip Off and Default handlers repeated three times with real local policy and unavailable Connect: zero requests or blocking modals. Linked routing and settings failure/retry pass. |
| `scheduleCache.test.js` | Memory/disk cache, remount, expiry, forced/manual/foreground refresh, event switching, failure recovery, unlink invalidation, unlinked UI, known-link discovery outage and legacy revision handling pass. |
| `sync.test.js` | Two simulated devices use real reducer and sync layer; new metadata arrives through catalog pulls, older metadata cannot erase discovery, unlink restores regular mode, persistence keeps status, and new seasons do not inherit old links. |
| `connectSchedule.test.js` | Real bridge with controlled HTTP: link discovery/persistence, malformed/mismatched snapshots, failed discovery preserving status, scheduled validation, defaults, retries, pagination and playoffs pass. |
| `connectLinkSync.database.test.js` | Two isolated PostgreSQL databases with PGlite 0.5.8, shipped migrations, real worker and receiver: backfill, draft/publish/unpublish, failures/retry, relink, rename, deletion/unlink, stale delivery/ack, permissions, game guard, existing games and authentication pass. Mobile migration applies twice safely. |
| `npm run lint` | Passed for the mobile repository. |
| Expo production export | iOS and Android Hermes bundles exported to ignored `dist/connect-link-verification`. Compiles the complete app; does not verify native pixels. |
| Connect unit/coverage, typecheck, lint, build and secret scan | Passed; detailed scope is recorded in the paired repository's `docs/MOBILE_LINK_SYNC.md` and `docs/work-status.md`. |

## Re-run

```powershell
node tests/connectLinkState.test.js --baseline # expected exit 1: original defect
node tests/connectLinkState.test.js            # expected exit 0
node tests/connectStartUi.test.js
node tests/scheduleCache.test.js
```

The optional database runtime is installed outside project dependencies. Set
`ITALA_PGLITE_MODULE` to its installed module path. Set `ITALA_CONNECT_ROOT` to
the paired checkout if it is not the sibling `iTala-connect-webapp` directory.
Then run `node tests/connectLinkSync.database.test.js` or `node tests/run.js`.
The runner can use an existing esbuild 0.24.0 binary through `ITALA_ESBUILD_BIN`
without requesting npm metadata.

## Not executed / rollout

Hosted Supabase gateway/auth/realtime, published Netlify scheduling, separate
concurrent PostgreSQL connections, Docker pgTAP/integration/browser E2E, and
native iPhone/iPad pixels are **NOT RUN**. Docker Desktop's engine pipe is absent;
`psql` is unavailable. PGlite runs real PostgreSQL SQL with adapted HTTP, without
replacing those checks. Native rotation, Split View, larger text and sign-in
sheets need the manual device checklist.

The code has not deployed either backend. Follow
[`../docs/CONNECT_LINK_SYNC.md`](../docs/CONNECT_LINK_SYNC.md) before release.
