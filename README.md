# iTala

> Record. Track. Elevate.

A fast, offline-first mobile scorekeeper for amateur basketball. One person taps
a stat, then taps a player. The app derives the live score, the box score, the
team fouls, the standings and every player's career line from that single stream
of taps, and anyone else can watch it happen live without an account.

This repository holds **v2**, a rebuild from the specification in
[`APP_CONTEXT_UPDATED.md`](APP_CONTEXT_UPDATED.md).

## Start here

| If you want to                      | Read                                                 |
| ----------------------------------- | ---------------------------------------------------- |
| Understand the product              | `APP_CONTEXT_UPDATED.md` sections 1 and 2            |
| Understand the code                 | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)       |
| Change anything                     | [`AGENTS.md`](AGENTS.md)                             |
| Know where v2 differs from the spec | [`docs/SPEC_DEVIATIONS.md`](docs/SPEC_DEVIATIONS.md) |
| Set up or deploy                    | [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)           |

## Layout

```
packages/domain      pure TypeScript: data model, stat maths, the reducer
packages/sync        pure sync engine: outbox, reconcile, realtime
apps/mobile          the Expo app
apps/web             read-only spectator view
supabase/migrations  versioned schema
```

## Working on it

Requires Node 22 and pnpm 10.

```bash
pnpm install
pnpm verify     # format check, lint, typecheck, tests. Run this before pushing.
pnpm test       # just the tests
```

`pnpm verify` is exactly what CI runs.

## The rule that matters most

Box scores and standings are **derived** from events, never stored as truth. If
you are about to add a cached score column, read `docs/ARCHITECTURE.md` first.
