// ============================================================================
// The pending-writes ledger for live game state, and the snapshot watermark.
//
// WHY THIS EXISTS (and what it replaces)
//
// Sync works by pulling the WHOLE server state and dispatching HYDRATE, which
// replaces local state wholesale. That is fine for data nobody is editing, and
// wrong for the one screen where a person is typing into the state faster than
// the network can carry it: the live scoreboard.
//
// A tap logs the event locally (instant +3) and starts an INSERT. Realtime is
// already firing refetches for earlier writes, so a snapshot TAKEN BEFORE that
// INSERT lands routinely arrives AFTER it. HYDRATE then applies a snapshot that
// predates the tap, and the basket vanishes. Seconds later the INSERT lands, a
// fresh snapshot arrives, and it comes back - by which time the scorekeeper has
// re-tapped, so the board jumps by six. That is the reported bug, exactly:
//
//     tap 3PM        -> 3      (local)
//     stale snapshot -> 0      (basket reverted)
//     tap 3PM        -> 3      (scorekeeper "fixes" it)
//     INSERT #1 lands, snapshot -> 6
//
// The previous defence was `undoGuard`: a 12-second tombstone that stopped a
// snapshot resurrecting an UNDONE event. It patched one direction of one case.
// Nothing at all protected a pending INSERT, which is the scoreboard itself.
// And a fixed time window is the wrong shape of answer: it is simultaneously
// too short (a slow push loses data) and too long (a genuinely failed delete is
// papered over for twelve seconds, then silently flips back).
//
// THE RULE THIS MODULE IMPLEMENTS INSTEAD
//
// A local write stays authoritative until a snapshot is known to have been
// taken AFTER the server confirmed that write. Not "for N seconds" - actually
// after, established by ordering rather than by a clock:
//
//   * every local write records an entry here
//   * when its push resolves, the entry is stamped with the current tick
//   * every fetch records the tick it STARTED at
//   * on HYDRATE, an entry is retired only when `confirmedAt < snapshotStarted`
//     - i.e. the server had already applied it before that snapshot was read,
//     so the snapshot genuinely reflects it. Otherwise the local op is
//     re-applied over the snapshot.
//
// Ticks are a monotonic counter, not wall-clock, so nothing here depends on
// latency, device clocks, or a threshold anyone has to tune.
//
// A write whose push FAILED is never retired. The scorekeeper's entry stays on
// the board and the sync badge stays in its error state, which is the honest
// outcome: silently reverting someone's stat minutes later - what the old
// timeout did - is the failure mode that made undo untrustworthy.
//
// AND THE RULE THE LEDGER ALONE DOES NOT GIVE YOU
//
// The ledger answers "may this snapshot overwrite my pending write?". It does
// NOT answer "has a NEWER snapshot already been applied?", and that gap is its
// own data-loss bug, reachable with no undo, no redo and no second device:
//
//     pull A starts (tick 7), reads 0 rows, its reply is slow in transit
//     tap 3PT                       -> 3, ledger protects the event
//     INSERT confirmed
//     pull B starts (tick 10), reads 1 row, lands first
//     HYDRATE(tick 10)              -> 3, and the ledger entry RETIRES
//                                        (correctly: the server does have it)
//     pull A finally lands
//     HYDRATE(tick 7)               -> 0    <- the basket is gone
//
// Nothing pulls again, because nothing changed on the server, so the board sits
// wrong until the next unrelated write. `acceptSnapshot` closes it: a snapshot
// older than the newest one already applied is refused outright.
//
// Undo is deliberately NOT affected by that rule. Undo is an ACTION - the user
// asking to move the state backward - not a snapshot. Only server snapshots go
// through the watermark.
// ============================================================================

import { Game, GameEvent } from '../types';

/** An entry's lifecycle position, shared by both entry kinds. */
interface Settled {
  leagueId: string;
  /** Tick at which the server acknowledged this write; null while in flight. */
  confirmedAt: number | null;
  /** True once the push rejected. Such an entry is pinned, never retired. */
  failed: boolean;
  /** Tick the entry was created at, used only for the safety cap below. */
  createdAt: number;
}

type PendingEntry =
  | (Settled & {
      kind: 'event';
      op: 'add' | 'remove';
      eventId: string;
      /** The row to re-insert. Present for 'add', absent for 'remove'. */
      event?: GameEvent;
    })
  | (Settled & {
      kind: 'game';
      gameId: string;
      /** The local game row to re-apply: lineups, period, status, attendance. */
      game: Game;
    });

// Monotonic logical clock. Every observable point in the write/fetch lifecycle
// takes a tick, so "before" and "after" are total and never tie.
let clock = 0;
function tick(): number {
  return ++clock;
}

// The newest snapshot tick that has actually been applied to local state. See
// `acceptSnapshot` - this is what stops an out-of-order reply from a slower
// concurrent pull reverting state a newer pull already committed.
let appliedAt = 0;

/**
 * Tokens, not ids.
 *
 * The ledger used to be keyed by event id alone, which meant an ADD and the
 * UNDO of that same event shared one slot - and `confirmPending(eventId)` could
 * not tell which of the two it was confirming. Undoing a mis-tap therefore
 * ended with the INSERT's acknowledgement stamped onto the UNDO's entry, so the
 * next snapshot retired the undo and handed the basket back. Keying by
 * operation makes a confirmation name the exact write it belongs to; a
 * confirmation for a write that has since been superseded finds nothing and is
 * correctly ignored.
 */
const eventToken = (op: 'add' | 'remove', eventId: string) => `${op}:${eventId}`;
const gameToken = (gameId: string) => `game:${gameId}`;

const pending = new Map<string, PendingEntry>();

// A ledger only grows while writes are failing, so in normal use it holds a
// handful of entries for a few hundred milliseconds. The cap is a backstop for
// a device that is offline for an entire game: bounded memory beats a perfect
// ledger nobody can sync anyway. Oldest entries go first - they are the ones a
// server snapshot is most likely to already agree with.
const MAX_ENTRIES = 1000;
function enforceCap(): void {
  if (pending.size <= MAX_ENTRIES) return;
  const byAge = [...pending.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  for (let i = 0; i < byAge.length - MAX_ENTRIES; i++) pending.delete(byAge[i][0]);
}

/**
 * CANONICAL EVENT ORDER, shared by the client and the server.
 *
 * `ts` alone is not a total order: two taps inside the same millisecond tie, and
 * PostgREST then returns them in whatever order the storage layer felt like. The
 * local array, meanwhile, kept insertion order. So "the last event of this game"
 * - which is the entire definition of Undo - could mean different rows on the
 * device and on the server, and a redone event (appended locally, re-sorted by
 * the server) could move. Breaking the tie on `id` makes the order total and
 * identical in both places, which is what lets Undo be well defined at all.
 */
export function compareEvents(a: GameEvent, b: GameEvent): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Sorted copy, in canonical order. */
export function sortEvents(events: readonly GameEvent[]): GameEvent[] {
  return [...events].sort(compareEvents);
}

/** Insert into an already-canonical list, keeping it canonical. */
export function insertEvent(events: readonly GameEvent[], ev: GameEvent): GameEvent[] {
  const out = [...events];
  let i = out.length;
  while (i > 0 && compareEvents(out[i - 1], ev) > 0) i--;
  out.splice(i, 0, ev);
  return out;
}

/** The event Undo should remove: the greatest in canonical order for this game. */
export function lastEventOf(events: readonly GameEvent[], gameId: string): GameEvent | undefined {
  let best: GameEvent | undefined;
  for (const e of events) {
    if (e.gameId !== gameId) continue;
    if (!best || compareEvents(e, best) > 0) best = e;
  }
  return best;
}

/* -------------------------------------------------------------- the ledger -- */

/**
 * Record that this event now exists locally but may not exist server-side yet.
 * Supersedes any pending removal of the same row (a redo after an undo).
 */
export function pendingAdd(leagueId: string, event: GameEvent): string {
  pending.delete(eventToken('remove', event.id));
  const token = eventToken('add', event.id);
  pending.set(token, {
    kind: 'event', leagueId, op: 'add', eventId: event.id, event,
    confirmedAt: null, failed: false, createdAt: tick(),
  });
  enforceCap();
  return token;
}

/**
 * Record that this event was removed locally but may still exist server-side.
 * Supersedes any pending insertion of the same row (an undo of a fresh tap).
 */
export function pendingRemove(leagueId: string, eventId: string): string {
  pending.delete(eventToken('add', eventId));
  const token = eventToken('remove', eventId);
  pending.set(token, {
    kind: 'event', leagueId, op: 'remove', eventId,
    confirmedAt: null, failed: false, createdAt: tick(),
  });
  enforceCap();
  return token;
}

/**
 * Record that this game row was changed locally - a lineup, a substitution, the
 * period, the status, attendance - and may not be on the server yet.
 *
 * This replaced `lineupGuard`, a 2.5-second tombstone in StoreProvider that
 * protected freshly-written lineups from a lagging realtime echo. Same class of
 * answer as the undo tombstone before it, and the same two failure modes: too
 * short for a slow push, and it flips its answer the moment its clock runs out.
 * A substitution is as much a committed user action as a basket, so it gets the
 * same ordering guarantee rather than a timer.
 *
 * There is one entry per game, holding the latest local row: consecutive edits
 * to the same game supersede each other, which is also how the push writes them
 * (`gameToRow` upserts the whole row).
 */
export function pendingGameWrite(leagueId: string, game: Game): string {
  const token = gameToken(game.id);
  pending.set(token, {
    kind: 'game', leagueId, gameId: game.id, game,
    confirmedAt: null, failed: false, createdAt: tick(),
  });
  enforceCap();
  return token;
}

/**
 * The push for these tokens reached the server. They stay in the ledger - a
 * snapshot already in flight was read BEFORE this moment and must still not be
 * allowed to contradict them - but they are now eligible for retirement by any
 * snapshot started after this tick.
 *
 * A token whose entry has since been superseded (undo after add, redo after
 * undo) is simply absent, and confirming it is correctly a no-op.
 */
export function confirmPending(tokens: readonly string[]): void {
  const at = tick();
  for (const token of tokens) {
    const e = pending.get(token);
    if (e) { e.confirmedAt = at; e.failed = false; }
  }
}

/** The push for these tokens rejected. Pin them: local stays authoritative. */
export function failPending(tokens: readonly string[]): void {
  for (const token of tokens) {
    const e = pending.get(token);
    if (e) { e.confirmedAt = null; e.failed = true; }
  }
}

/** The shape `recordPending` needs off an action. Structural on purpose: this
 *  module must not import the reducer's Action union, or store and sync would
 *  form an import cycle. */
interface EventAction {
  t: string;
  leagueId?: string;
  id?: string;
  eventId?: string;
  gameId?: string;
}
interface PostState {
  leagues: { id: string; events: GameEvent[]; games: Game[] }[];
}

const leagueOf = (state: PostState, leagueId: string) => state.leagues.find(l => l.id === leagueId);

/**
 * Record an action's effect on the ledger and return the tokens its push is
 * responsible for. The caller hands those back to `confirmPending` or
 * `failPending` when the push settles.
 *
 * One function for both halves so the recording side and the settling side
 * cannot drift apart — the previous arrangement had the dispatch wrapper
 * tombstoning undo ids in one place and lifting them in another, and the two
 * used different notions of which event was involved.
 *
 * Game rows are recorded by DIFFING `prev` against `next` rather than from a
 * list of action types. Six actions write a game row directly, and three more
 * (`ADD_EVENT`, `UNDO_EVENT`, `DELETE_EVENT`) write one only sometimes, when a
 * foul crosses the foul-out limit and the reducer benches the player. A list
 * would have to encode that condition twice and stay in step with it; the diff
 * cannot fall out of step, because it asks the reducer what it actually did.
 */
export function recordPending(action: EventAction, prev: PostState, next: PostState): string[] {
  const leagueId = action.leagueId;
  if (!leagueId) return [];
  const tokens: string[] = [];

  if (action.t === 'ADD_EVENT' || action.t === 'REDO_EVENT') {
    const id = action.t === 'ADD_EVENT' ? action.id : action.eventId;
    const ev = id ? leagueOf(next, leagueId)?.events.find(e => e.id === id) : undefined;
    if (ev) tokens.push(pendingAdd(leagueId, ev));
  } else if (action.t === 'UNDO_EVENT' || action.t === 'DELETE_EVENT') {
    if (action.eventId) tokens.push(pendingRemove(leagueId, action.eventId));
  }

  // Whatever else it did, did this action change the game row the push mirrors?
  if (action.gameId) {
    const before = leagueOf(prev, leagueId)?.games.find(g => g.id === action.gameId);
    const after = leagueOf(next, leagueId)?.games.find(g => g.id === action.gameId);
    // Reference inequality: the reducer copies a game row it changes and leaves
    // every other row identical, so this is exact and costs nothing.
    if (after && after !== before) tokens.push(pendingGameWrite(leagueId, after));
  }

  return tokens;
}

/* ----------------------------------------------------------- the watermark -- */

/** Take the tick a fetch is starting at. Pass it back to `reconcile`. */
export function beginSnapshot(): number {
  return tick();
}

/**
 * May this server snapshot be applied?
 *
 * Yes only if it was read after every snapshot already applied. Concurrent
 * pulls - a realtime refetch, the boot retry loop, an auth re-pull, and
 * pull-to-refresh all existed independently - can otherwise deliver their
 * replies out of order, and the older reply wins simply by arriving last. The
 * ledger cannot catch that on its own: by then the newer snapshot has legitimately
 * retired the entry that was protecting the write.
 *
 * Accepting also CLAIMS the watermark, so this must be called exactly once per
 * snapshot, immediately before hydrating it, and never from inside the reducer
 * (React may run a reducer more than once for the same action).
 */
export function acceptSnapshot(snapshotStarted: number): boolean {
  if (snapshotStarted <= appliedAt) return false;
  appliedAt = snapshotStarted;
  return true;
}

/** The newest snapshot tick applied so far. Diagnostics and tests. */
export function appliedSnapshotAt(): number {
  return appliedAt;
}

/** Diagnostics/tests: how many local writes are still unreconciled. */
export function pendingCount(): number {
  return pending.size;
}

/** Test hook: empty the ledger between suites. */
export function __resetPending(): void {
  pending.clear();
  clock = 0;
  appliedAt = 0;
}

/* --------------------------------------------------------- reconciliation -- */

/** Has the server demonstrably applied this write before the snapshot was read? */
function retirable(e: PendingEntry, snapshotStarted: number): boolean {
  return !e.failed && e.confirmedAt !== null && e.confirmedAt < snapshotStarted;
}

/**
 * Apply the ledger to one league's incoming server events.
 *
 * `snapshotStarted` is the tick returned by `beginSnapshot()` before the fetch
 * that produced these rows. Entries confirmed strictly before that tick are
 * retired and the server's version wins; everything else is re-applied on top.
 *
 * Retiring mutates the ledger, and React is free to run a reducer more than
 * once for the same action, so this has to be idempotent - and is: an entry is
 * only ever retired once the snapshot in hand is known to already reflect it, so
 * a second run over the same snapshot produces the same rows from the server
 * alone.
 */
export function reconcileLeagueEvents(
  leagueId: string,
  serverEvents: readonly GameEvent[],
  snapshotStarted: number,
): GameEvent[] {
  if (pending.size === 0) return sortEvents(serverEvents);

  const retire: string[] = [];
  const drop = new Set<string>();
  const add: GameEvent[] = [];

  for (const [token, e] of pending) {
    if (e.kind !== 'event' || e.leagueId !== leagueId) continue;
    if (retirable(e, snapshotStarted)) {
      // The server had applied this before the snapshot was read, so the
      // snapshot already reflects it and the ledger has nothing left to say.
      retire.push(token);
      continue;
    }
    if (e.op === 'remove') drop.add(e.eventId);
    else if (e.event) add.push(e.event);
  }

  // Retire AFTER the loop so iteration order can't affect the outcome.
  for (const token of retire) pending.delete(token);

  const have = new Set<string>();
  const out: GameEvent[] = [];
  for (const ev of serverEvents) {
    if (drop.has(ev.id)) continue;
    have.add(ev.id);
    out.push(ev);
  }
  for (const ev of add) {
    if (!have.has(ev.id)) out.push(ev);
  }
  return sortEvents(out);
}

/**
 * Apply the ledger to one league's incoming server games.
 *
 * Same rule as the events above, on the row that holds the on-court five, the
 * period, the status and attendance. A game the snapshot does not have yet is
 * re-added rather than dropped: its INSERT is still in flight, and deleting a
 * just-created game locally is what made a drop-in game open with a "?" team.
 *
 * `localGames` is the league's games as they stand on the device right now, and
 * it is what keeps that re-adding honest. A ledger entry is a LOCAL write held
 * open until the server agrees with it - so if the row is no longer on the
 * device, there is no local write left to protect and the entry is dropped. That
 * matters most for a write that FAILED, because such an entry is pinned rather
 * than retired: a drop-in game whose transaction was rejected is rolled back
 * locally (see ROLLBACK_BUNDLE), and without this the pinned entry would put the
 * rolled-back game straight back on the next pull, pointing at teams and players
 * the rollback had also removed. Deleting a game, cleaning up rec games and
 * deleting a team all remove game rows too, and none of them would have been
 * caught by a list of actions to special-case.
 */
export function reconcileLeagueGames(
  leagueId: string,
  serverGames: readonly Game[],
  snapshotStarted: number,
  localGames: readonly Game[] = [],
): Game[] {
  if (pending.size === 0) return [...serverGames];

  const stillLocal = new Set(localGames.map(g => g.id));
  const retire: string[] = [];
  const local = new Map<string, Game>();

  for (const [token, e] of pending) {
    if (e.kind !== 'game' || e.leagueId !== leagueId) continue;
    if (retirable(e, snapshotStarted) || !stillLocal.has(e.gameId)) { retire.push(token); continue; }
    local.set(e.gameId, e.game);
  }
  for (const token of retire) pending.delete(token);

  if (local.size === 0) return [...serverGames];

  const seen = new Set<string>();
  const out = serverGames.map(g => {
    seen.add(g.id);
    return local.get(g.id) ?? g;
  });
  // Local order prepends new games; keep that so a just-created game stays at
  // the top of the list it was created into.
  const missing = [...local.values()].filter(g => !seen.has(g.id));
  return missing.length ? [...missing, ...out] : out;
}
