// ============================================================================
// Input-safety helpers for the live game screen.
//
// Both of these exist because React state is not a safe guard against a second
// event that arrives before the first one's re-render commits. They are pure so
// they can be tested without rendering LiveGameScreen, which this project has no
// harness for.
// ============================================================================

/**
 * Take the value out of a mutable box, leaving it empty. Returns null if the box
 * was already empty.
 *
 * This is the double-tap guard for the two-tap stat pad (F-18). The screen's
 * `log()` already checked `if (!armed) return` and cleared `armed` afterwards,
 * which looks sufficient and is not: `armed` is a `useState` value captured in
 * the tap handler's closure, and `setArmed(null)` does not change that captured
 * value. Two taps processed before the re-render commits therefore both see the
 * stat still armed, and both dispatch - one fumbled double-tap becomes two
 * points, or two fouls, in a live game.
 *
 * A ref mutates immediately, so claiming through it is atomic with respect to
 * the render cycle: the second tap in the same frame gets null and returns.
 * Preferred over a time-based lockout because it has no arbitrary threshold and
 * never rejects a genuine second action - once the stat is re-armed, the next
 * tap is accepted however fast it arrives.
 */
export function claimOnce<T>(box: { current: T | null }): T | null {
  const value = box.current;
  if (value === null || value === undefined) return null;
  box.current = null;
  return value;
}

/**
 * Order-independent identity for an on-court set. Sorted because the lineup is a
 * set of five, not a batting order - reordering the same five players must not
 * read as someone being substituted.
 */
export function courtKeyOf(ids: readonly string[]): string {
  return [...ids].sort().join(',');
}

export interface LineupReconcile {
  /** New selection to adopt, or null to leave the user's selection alone. */
  reseed: string[] | null;
  /** The court key the selection should now be considered seeded from. */
  seedKey: string;
  /** True when the court moved AND the user has unsaved edits, so confirming would silently revert someone. */
  conflict: boolean;
}

/**
 * Decide what a "Set 5" lineup picker should do when the on-court set changes
 * while it is open (F-17).
 *
 * The picker seeds its selection from `onCourtIds` with `useState`, which only
 * reads its initial value once. A realtime HYDRATE from another device, or an
 * auto-bench, can therefore change who is on court while the sheet sits open,
 * and confirming then writes a lineup built from a world that no longer exists -
 * silently reverting the other device's change.
 *
 * Three cases, and the middle one is why this is not just a `useEffect` that
 * re-seeds on every change:
 *
 *   - nothing moved            -> do nothing
 *   - court moved, no edits    -> re-seed silently, the user loses nothing
 *   - court moved, with edits  -> conflict: keep their work and let the screen
 *                                 ask, because both "discard theirs" and
 *                                 "discard the other device's" are wrong to pick
 *                                 automatically
 */
export function reconcileLineup(args: {
  courtIds: readonly string[];
  seedKey: string;
  touched: boolean;
}): LineupReconcile {
  const key = courtKeyOf(args.courtIds);
  if (key === args.seedKey) {
    return { reseed: null, seedKey: args.seedKey, conflict: false };
  }
  if (!args.touched) {
    return { reseed: [...args.courtIds], seedKey: key, conflict: false };
  }
  return { reseed: null, seedKey: args.seedKey, conflict: true };
}
