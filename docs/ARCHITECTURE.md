# Architecture

## The one idea

Every number this app shows is a fold over an append-only event log. Nothing
numeric is stored. Scores, box scores, standings, streaks, leaderboards, career
averages and badges are all recomputed from `League.events` on demand.

That single decision is why correcting a mistake is deleting one row, why no
cache can go stale, and why the play-by-play is free. It is also the thing most
likely to be "optimised" away by someone who has not read this file. Do not.

## Layout

```
packages/domain/     Pure TypeScript. No React, no Expo, no network, no clock.
  types.ts           The data model. Effectively the specification.
  constants.ts       Game rules: max periods, lineup size, default foul limit.
  ids.ts             Client-generated, time-sortable IDs.
  format.ts          Percentages, averages, day keys, the timeout clock parser.
  stats.ts           ALL derivation. The maths that must be right.
  ops.ts             Row serialisers and the sync operation type.
  reducer.ts         The single mutation funnel. Pure.
  __tests__/         Golden tests, written from the spec by hand.

apps/mobile/         Expo app. Screens, local SQLite store, sync engine.
apps/web/            Read-only spectator view. Imports packages/domain.
supabase/migrations/ Versioned SQL. The only way schema changes reach a project.
```

`packages/domain` is deliberately free of every platform dependency. That is
what lets the same arithmetic run in the app, in the spectator web view, and in
a test runner that finishes in under two seconds.

## Data flow

```
  user taps a stat
        |
        v
  caller generates an id and a timestamp
        |
        v
  reduce(state, action)  ->  { state, ops }        PURE
        |                        |
        |                        +--> outbox rows, written in the SAME
        |                             local transaction as the domain rows
        v                                        |
  in-memory state, re-rendered                   v
                                          outbox drainer
                                          (retry, exponential backoff)
                                                 |
                                                 v
                                          Supabase / Postgres
                                                 |
                                     realtime postgres_changes
                                                 |
                                                 v
                                  incremental upsert into local SQLite,
                                  never clobbering a row with a pending op
```

Three properties fall out of this and each fixes a named defect in v1:

- The reducer says exactly which rows changed, so sync never guesses. (v1 took
  the last element of an array and hoped.)
- The outbox is durable and ordered, so a write cannot be silently dropped, an
  undo cannot resurrect itself, and a reconnect does not overwrite unsent work.
- Realtime is applied, not used as a trigger to re-download everything.

## What is authoritative, and where

| Thing               | Authority       | Note                                                                                          |
| ------------------- | --------------- | --------------------------------------------------------------------------------------------- |
| IDs                 | the client      | Generated before any network call, so offline creation is the same code path as online.       |
| Timestamps          | the client      | Epoch milliseconds. The server's own `created_at` is never read.                              |
| Numeric truth       | the event log   | Recomputed everywhere, stored nowhere.                                                        |
| Write permission    | the database    | Row-level security. Every UI check is cosmetic.                                               |
| Conflict resolution | last write wins | Two scorekeepers should not be on the same game. Events never collide because IDs are unique. |

## Testing strategy

`packages/domain` is tested exhaustively because it is pure and because every
number in the product comes out of it. The assertions were worked out by hand
from `APP_CONTEXT_UPDATED.md` section 7, not by running the code and recording
the output. That distinction is the whole value of the suite.

Everything above the domain is tested by running the app. The verification
script for each phase lives in `docs/VERIFY.md`.
