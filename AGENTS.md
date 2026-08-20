# Engineering rules for iTala v2

## Rule zero: verify at the outermost layer you can reach

Every failure that has reached the user in this project so far had the same
shape. Something was checked at the layer it was written in, and broke at the
layer the user actually consumes.

**Before saying anything works:**

```bash
pnpm preflight          # everything checkable without a phone in your hand
```

Seven steps: format, lint, typecheck, tests, expo-doctor, a real bundle of both
platforms, and the database harness. It prints PASS, FAIL or SKIP for each.
**If a step is skipped, say so rather than reporting a clean run.** Use
`pnpm preflight:quick` while iterating; run it in full before shipping.

`pnpm verify` is the fast inner loop and is what a pull request needs to pass.
It is NOT sufficient on its own: it stops at typecheck and tests, and three of
the incidents below passed it.

### The ladder

Whatever you changed, check one layer further out than feels necessary.

| If you changed                               | Typecheck proves | You must also                                                                     |
| -------------------------------------------- | ---------------- | --------------------------------------------------------------------------------- |
| Derivation, the reducer, sync logic          | the shape        | run the tests; add one that would have caught the bug                             |
| An import, a path, a module boundary         | nothing useful   | bundle it: `pnpm --filter @itala/mobile run bundle:check`                         |
| Any dependency, or app.json                  | nothing          | `pnpm --filter @itala/mobile run expo:doctor`                                     |
| SQL, RLS, a constraint                       | nothing          | `bash supabase/tests/run.sh`                                                      |
| A shell script, or anything with a file mode | nothing          | assume Windows drops the executable bit; invoke it as `bash script.sh`            |
| Anything shipped as a zip                    | nothing          | remember extraction cannot DELETE. Ship a manifest and use `tools/sync-phase.ps1` |
| Anything the user runs by hand               | nothing          | read your own instructions back in order, on their platform, from a cold start    |

### The incident log

Each of these cost real time. They are here so the reason survives the fix, the
same way v1's best comments did.

| What broke                                                                   | Looked fine because                              | The rule now                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| Metro could not resolve `expo-modules-core`                                  | pnpm's isolated layout is invisible to typecheck | `node-linker=hoisted` in `.npmrc`. Never remove it                   |
| Relative imports with a `.js` suffix                                         | TypeScript resolves them, Metro does not         | Relative imports stay extensionless                                  |
| 3.9MB of unused icon and font assets                                         | nothing errors, the app just gets fat            | Import icon sets and font weights by subpath, never the barrel       |
| `RCTPackagerConnection has no member 'shared'`, 25 minutes into an EAS build | the versions looked plausible                    | R-20. Expo packages come from `expo install`, never by hand          |
| CI: `./supabase/tests/run.sh: Permission denied`                             | it was executable on Linux                       | Invoke scripts as `bash script.sh`                                   |
| `format:check` failing on a machine that changed nothing                     | `^` on prettier                                  | Tooling pinned exactly. Expo SDK packages excepted, see R-20         |
| A deleted screen kept coming back and failing lint                           | `Expand-Archive` cannot delete                   | Every drop carries `MANIFEST.txt`; apply with `tools/sync-phase.ps1` |
| "Run `./tools/sync-phase.ps1`" when the script was inside the zip            | the instruction was written from the wrong end   | Read setup instructions back from a cold start, in order             |
| No `eas.json`, so no build was possible at all                               | CI was green                                     | Green CI does not mean shippable. Check the whole path to the user   |

---

This file is the durable, load-bearing guidance for anyone (human or agent)
working in this repository. v1 had no such file; what it had instead was a
dozen unusually good code comments written after real production incidents.
Those rules are preserved below, marked **[v1]**, alongside the new ones this
rebuild established.

Read `docs/ARCHITECTURE.md` for the shape of the system and
`docs/SPEC_DEVIATIONS.md` for every deliberate departure from
`APP_CONTEXT_UPDATED.md`, which is the specification and the source of truth.

---

## The rules

**R-1. [v1] Box scores and standings are DERIVED from events, never stored as truth.**
Nothing numeric is persisted. No cached score column, no materialised standings
table, no denormalised career totals. Correcting a mistake is deleting one row,
and every number updates. The moment an aggregate is stored, it starts drifting
from the log and no test will notice for months.

**R-2. [v1] Autosave every mutation. A live game must never die.**
The local write happens before anything else and it is best effort: a failed
write must never crash a game in progress.

**R-3. [v1] No Supabase call is ever awaited without a timeout.**
supabase-js auth methods can hang in React Native when storage or locks stall,
and a hung await silently freezes the calling flow. This was a real production
bug. Every call races a timeout and always produces a definite result.

**R-4. [v1] Lime is rare on purpose.**
Teal is identity and structure. Lime means "happening now" or "do this". Green
is success, red is danger, yellow is a timeout marker, muted is de-emphasis.
Putting lime on a routine button burns the eye.

**R-5. [v1] The password overlay is not a React Native `<Modal>`.**
RN's Modal has had touch-delivery quirks on this surface. If you find yourself
"simplifying" a hand-rolled overlay back into a Modal, test touch delivery on a
real device first.

**R-6. [v1] Wait for the auth session before the first read.**
Without the wait, the initial pull runs as an unauthenticated caller, row-level
security returns an empty array with no error, and the device looks like it has
lost all its data. That failure mode is silent and expensive to diagnose.

**R-7. [v1] Do not block the app on font loading.**
Give up after a short timeout and render with system fonts. An app that opens
looking slightly wrong beats an app that does not open.

**R-8. [v1] Authorisation lives in the database, not in the client.**
Row-level security is the only real enforcement. Every `isAdmin` check in the UI
is cosmetic and the code should say so where it matters. `admin_secret` has no
policies at all, deliberately, so nothing can read it through the API. That is
not an oversight; do not "fix" it.

**R-9. The reducer is pure.**
No `Date.now()`, no `Math.random()`, no I/O, no logging. Timestamps and IDs are
generated by the caller and carried on the action. This is what makes the tests
deterministic and the sync layer exact.

**R-10. Every mutation states exactly which rows changed.**
The reducer returns `{ state, ops }`. The sync layer never infers what happened
by inspecting arrays. v1 located just-created rows by taking the last array
element, which meant changing an append to a prepend would silently push the
wrong row with no type error anywhere.

**R-11. Every create action carries its own ID, generated by the caller.**
A record has its permanent identity before any network call, so offline
creation and sync are the same code path.

**R-12. Events are inserted, never upserted.**
The primary key is the idempotency guard: a replayed insert either succeeds or
conflicts, and both mean the stat is on the server exactly once. Changing this
to an upsert makes double-logging possible.

**R-13. `playerId: null` is meaningful, not missing.**
It marks a team-level event. Those rows must appear in team totals. Treating
null as "skip this row" silently loses points from the score.

**R-14. Write the test before the code, for anything in `packages/domain`.**
That package is pure and dependency-free precisely so this is cheap. Assertions
are derived by hand from the specification, not by running the code and
recording whatever it produced.

**R-15. Never surface a silent failure.**
If a write cannot reach the server, the user is told. The app's whole promise is
"never lose a game", and v1 could lose one without a word.

**R-16. No non-null assertions on soft references outside tests.**
The lint rule enforces it. v1 combined "no foreign keys" with `!` assertions
that assumed foreign keys, which is how a deleted team turned into a crash.

**R-17. Keep writing down _why_.**
Comments that explain a decision, a trade-off or an incident are the most
valuable thing in this repository. Comments that restate the code are noise.

**R-18. Accessibility is written as the component is written.**
Every pressable gets a label and a role. Retrofitting is far more expensive than
doing it once, and emoji are not icons.

**R-19. Secrets never enter the repository.**
Not in code, not in a commit message, not in documentation, not in a test
fixture. The admin password is set by a manual SQL snippet against the database
and exists nowhere else. `.env` is gitignored; `.env.example` carries blanks.

**R-20. Never hand-write an Expo package version. Use `expo install`.**
Expo's own packages are versioned against the SDK, not independently.
Hand-writing `expo-dev-client: ^6.0.0` installed a package built for an older
React Native, and the failure surfaced as a Swift compile error twenty minutes
into an EAS build rather than anywhere useful. `pnpm --filter @itala/mobile run
expo:doctor` catches all of it in seconds, and CI runs it on every pull request.
Tooling (formatter, linter, TypeScript) is pinned exactly; Expo SDK packages
are managed by `expo install` and left in the ranges it chooses.

**R-21. Typechecking is not proof the app builds.**
A bad import, an unresolvable module or a Metro misconfiguration all pass
`tsc` and fail the bundler. CI exports both platforms for this reason.

**R-22. Deviations from the specification are deliberate and recorded.**
If behaviour departs from `APP_CONTEXT_UPDATED.md`, it goes in
`docs/SPEC_DEVIATIONS.md` with a reason, and the code comment points at the
entry. Undocumented drift is how a rebuild becomes a rewrite.
