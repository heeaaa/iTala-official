// ============================================================================
// The pending-writes ledger for game events.
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
//   * every local event write records an entry here, keyed by event id
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
// ============================================================================

import { GameEvent } from '../types';

type PendingOp = 'add' | 'remove';

interface PendingEntry {
  leagueId: string;
  op: PendingOp;
  /** The row to re-insert. Present for 'add', absent for 'remove'. */
  event?: GameEvent;
  /** Tick at which the server acknowledged this write; null while in flight. */
  confirmedAt: number | null;
  /** True once the push rejected. Such an entry is pinned, never retired. */
  failed: boolean;
  /** Tick the entry was created at, used only for the safety cap below. */
  createdAt: number;
}

// Monotonic logical clock. Every observable point in the write/fetch lifecycle
// takes a tick, so "before" and "after" are total and never tie.
let clock = 0;
function tick(): number {
  return ++clock;
}

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

/** Record that this event now exists locally but may not exist server-side yet. */
export function pendingAdd(leagueId: string, event: GameEvent): void {
  pending.set(event.id, {
    leagueId, op: 'add', event, confirmedAt: null, failed: false, createdAt: tick(),
  });
  enforceCap();
}

/** Record that this event was removed locally but may still exist server-side. */
export function pendingRemove(leagueId: string, eventId: string): void {
  pending.set(eventId, {
    leagueId, op: 'remove', confirmedAt: null, failed: false, createdAt: tick(),
  });
  enforceCap();
}

/**
 * The push for these ids reached the server. They stay in the ledger - a
 * snapshot already in flight was read BEFORE this moment and must still not be
 * allowed to contradict them - but they are now eligible for retirement by any
 * snapshot started after this tick.
 */
export function confirmPending(eventIds: readonly string[]): void {
  const at = tick();
  for (const id of eventIds) {
    const e = pending.get(id);
    if (e) { e.confirmedAt = at; e.failed = false; }
  }
}

/** The push for these ids rejected. Pin them: local stays authoritative. */
export function failPending(eventIds: readonly string[]): void {
  for (const id of eventIds) {
    const e = pending.get(id);
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
}
interface PostState {
  leagues: { id: string; events: GameEvent[] }[];
}

/**
 * Record an action's effect on the ledger and return the event ids its push is
 * responsible for. The caller hands those ids back to `confirmPending` or
 * `failPending` when the push settles.
 *
 * One function for both halves so the recording side and the settling side
 * cannot drift apart — the previous arrangement had the dispatch wrapper
 * tombstoning undo ids in one place and lifting them in another, and the two
 * used different notions of which event was involved.
 */
export function recordPending(action: EventAction, next: PostState): string[] {
  const leagueId = action.leagueId;
  if (!leagueId) return [];

  if (action.t === 'ADD_EVENT' || action.t === 'REDO_EVENT') {
    const id = action.t === 'ADD_EVENT' ? action.id : action.eventId;
    if (!id) return [];
    const ev = next.leagues.find(l => l.id === leagueId)?.events.find(e => e.id === id);
    if (!ev) return [];
    pendingAdd(leagueId, ev);
    return [id];
  }

  if (action.t === 'UNDO_EVENT' || action.t === 'DELETE_EVENT') {
    if (!action.eventId) return [];
    pendingRemove(leagueId, action.eventId);
    return [action.eventId];
  }

  return [];
}

/** Take the tick a fetch is starting at. Pass it back to `reconcile`. */
export function beginSnapshot(): number {
  return tick();
}

/** Diagnostics/tests: how many local writes are still unreconciled. */
export function pendingCount(): number {
  return pending.size;
}

/** Test hook: empty the ledger between suites. */
export function __resetPending(): void {
  pending.clear();
  clock = 0;
}

/**
 * Apply the ledger to one league's incoming server events.
 *
 * `snapshotStarted` is the tick returned by `beginSnapshot()` before the fetch
 * that produced these rows. Entries confirmed strictly before that tick are
 * retired and the server's version wins; everything else is re-applied on top.
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

  for (const [id, e] of pending) {
    if (e.leagueId !== leagueId) continue;
    if (!e.failed && e.confirmedAt !== null && e.confirmedAt < snapshotStarted) {
      // The server had applied this before the snapshot was read, so the
      // snapshot already reflects it and the ledger has nothing left to say.
      retire.push(id);
      continue;
    }
    if (e.op === 'remove') drop.add(id);
    else if (e.event) add.push(e.event);
  }

  // Retire AFTER the loop so iteration order can't affect the outcome.
  for (const id of retire) pending.delete(id);

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
