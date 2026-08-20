# Deliberate deviations from APP_CONTEXT_UPDATED.md

`APP_CONTEXT_UPDATED.md` is the specification. Everything here is a place where
v2 knowingly does something different, why, and who signed it off.

Anything not listed here is intended to match the specification exactly. If you
find behaviour that differs and is not recorded below, that is a bug in v2, not
an improvement.

All items were agreed with the product owner on 19/08/2026 unless noted.

---

## D-1. Opponent-only teams are removed

**Spec:** F-7, `Team.teamOnly`, and branches in F-17, F-18, F-24, S-7, S-8.
**v2:** removed entirely. Every team has a roster.
**Why:** it put a conditional branch through nearly every screen to serve a case
the leagues in question do not have. Signed off as answer O-3.
**Retained:** `events.player_id` stays nullable, because timeouts are still
team-level events.

## D-2. The `oreb` and `dreb` event types are removed

**Spec:** section 4.3, `apply()` in 7.5.
**v2:** the event type union has 13 members, not 15.
**Why:** they existed only to keep aggregating rows written by an older version.
v2 starts on an empty database, so there is nothing to be defensive about.
Rebounds stay combined, as the spec's answer 20 confirmed.

## D-3. The `scheduled` game status is removed

**Spec:** section 4.3, `GameStatus`.
**v2:** status is `live | final`.
**Why:** nothing in v1 could ever produce it. A value the system supports
everywhere and can never create is exactly the trap that produced the
permanently-zero turnover column. It comes back when a real scheduling feature
does.

## D-4. The foul-out limit is honoured, not capped

**Spec:** 7.8 `effectiveFoulLimit`, continuity constraint C-5.
**v2:** `foulLimit()` returns the league's stored value. Only a missing or
nonsensical value falls back to 5.
**Why:** v1's read-time cap defended against legacy rows saved with 6. There are
no legacy rows, and the cap's only remaining effect was to make NBA rules
impossible forever. `foul_out_limit` becomes a real per-league setting with a
UI, defaulting to FIBA 5.

## D-5. Box-score rows sort deterministically

**Spec:** 7.5, which sorts by points descending and stops there.
**v2:** points descending, then roster order, then id.
**Why:** v1's sort was unstable for equal point totals, so two players on zero
could swap places between renders. Correctness-first makes a stable table worth
the extra comparator.

## D-6. A tied final game is a draw, not a home win

**Spec:** 7.6, `const homeWon = s.home >= s.away`, listed as known hole H-4.
**v2:** a level game increments `draws` for both teams, the streak mark is `D`,
and win percentage is `(wins + 0.5 x draws) / games`. The UI warns before
finishing a level game and offers to add a period instead.
**Why:** basketball goes to overtime, so this is rare, but silently awarding the
win to whichever team is listed first is not defensible. Explicitly signed off
as a change to section 7.

## D-7. Head-to-head is applied as a tiebreak

**Spec:** 7.6, where the source comment says head-to-head was "omitted for
brevity". Sort is win% then differential.
**v2:** win% then head-to-head then differential, with head-to-head applied
**only when exactly two teams are tied on win percentage**.
**Why:** it is the conventional order and it was requested. Restricting it to an
exact pair avoids circular ties among three or more teams, which have no
well-defined resolution and would make the ordering unstable.

## D-8. The reducer is pure; callers supply time and identity

**Spec:** 7.1, where the reducer calls `Date.now()` and generates IDs.
**v2:** every action carries `id` and, where relevant, `now`.
**Why:** determinism. It is what makes the golden tests possible and what lets
the reducer emit exact rows for the sync layer.

## D-9. Settings are per league, not global

**Spec:** F-19 and the `app_settings` table, where `trackMisses` is one global
boolean applied to every league on every device.
**v2:** `track_misses`, `track_turnovers`, `foul_out_limit` and
`regulation_periods` are columns on `leagues`. The `app_settings` table does not
exist.
**Why:** a competitive league and a Tuesday pickup run should not be forced to
share a data-richness policy. The spec's own answer on turnovers describes it as
a league setting.

## D-10. Team logos live in object storage

**Spec:** F-10 and section 4.2, where `teams.logo` holds a base64 data URI
inline in the row.
**v2:** `teams.logo_url` holds a URL into Supabase Storage.
**Why:** inline base64 inflates every fetch, is the field most likely to break an
export, and v1's fallback path could store a device-local `file://` URI that is
a broken image on every other device forever.

## D-11. Soft delete for players and teams, and real foreign keys

**Spec:** section 4.9, where everything is a hard delete and five of ten
relationships have no foreign key. Known holes H-2 and H-3.
**v2:** `players` and `teams` carry `deleted_at`. Games and events are still hard
deleted. `games.home_team_id`, `games.away_team_id`, `events.team_id` and
`events.player_id` get real foreign keys.
**Why:** soft delete is what makes the foreign keys survivable. It keeps history
resolvable (a deleted player's stats still show their name rather than the
literal string "Player") while removing them from every picker. v1's position -
no constraints plus `!` assertions that assumed constraints - is what turned a
deleted team into a crash.

## D-12. The day-grouping key takes an explicit timezone

**Spec:** 7.14 `dayKey`, which reads the device's local calendar date, and trap
T-13.
**v2:** `dayKey(ts, timeZone?)`.
**Why:** the key is used as a route parameter and will be shared with the
spectator web view. Two devices in different timezones must agree on which day a
game belongs to.

## D-13. The admin password is hashed and rate limited

**Spec:** section 9.4 and continuity constraint C-1. v1 stored it in plaintext,
duplicated it as a hardcoded client constant, and granted the checking RPC to
`anon` with no rate limiting, no lockout and no attempt logging.
**v2:** bcrypt via pgcrypto, database only, with per-caller rate limiting and
lockout. There is no client-side fallback constant. The value is set by a manual
SQL snippet and appears in no file in this repository.
**Why:** the anon key ships in the app binary, so the RPC is callable by anyone
at any rate. A short shared secret was trivially brute-forceable.

## D-14. Local persistence is SQLite, not a serialised state blob

**Spec:** F-40 and 7.3, where the entire state tree, including every base64
logo, is serialised to AsyncStorage under `hoops.state.v1` on every mutation.
Continuity constraint C-6.
**v2:** `expo-sqlite`. One local table per domain table, each holding
`(id, league_id, data)` where `data` is the row as JSON in exactly the shape the
server stores it.
**Why:** appending one stat becomes one row insert rather than serialising the
whole season. It makes the outbox durable and crash-safe, and it lets the domain
rows and the outbox entry be written in a single transaction, which is what
makes "applied locally but never sent" impossible.

Rows are stored opaquely rather than as a column per field because the local
database is a **cache, not a query surface**: everything is projected into
memory and derived from there, so there is nothing to index on. Keeping the row
shape identical on both sides means there is exactly one mapping in the system
(`project()` in `@itala/domain`), tested by round trip, instead of v1's
hand-written per-table mappers with their unchecked casts and quiet coercions.
If a later phase needs local SQL queries, splitting the JSON into columns is a
mechanical change behind the same `LocalStore` interface.

C-6 is void because no device holds v1 data.

## D-15. A durable outbox replaces fire-and-forget pushes

**Spec:** 7.10 and known holes H-1, H-3, H-8, plus section 10.6's observation
that the app cannot recover from an outage.
**v2:** every mutation writes its rows and its outbox entries in one local
transaction. A drainer retries with exponential backoff and only clears an entry
on confirmed acknowledgement. A remote pull never overwrites a row with a
pending entry.
**Why:** one structure fixes four separate defects, including undo silently
resurrecting itself on a second device.

## D-16. Realtime payloads are applied incrementally

**Spec:** 7.10, where any remote change triggers a full re-download of five
tables, including every logo, and the payload is discarded.
**v2:** the changed row is upserted directly. A full reconcile still runs on app
foreground and on a timer, as a safety net rather than as the mechanism.
**Why:** it turns an operation proportional to the whole database into a
constant one, and it makes the device's own writes echoing back harmless.

## D-17. The outbox drains in strict sequence order

**Spec:** not covered. v1 had no queue at all.
**v2:** the drainer reads the head of the queue regardless of schedule and
**stops** when the head is not yet due, rather than skipping to the next
entry.
**Why:** found by a test during Phase 1. An earlier version filtered the queue
by `nextAttemptAt`, which meant a backed-off entry could be overtaken by the
entries behind it, and a team could reach the server before the league it
belongs to. Ordering here is causal, not a preference. There is a named
regression test for it.
