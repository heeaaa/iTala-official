// ============================================================================
// One answer to "is my work saved?", for every screen that asks.
//
// WHY THIS EXISTS
//
// Three screens showed a sync state and all three showed a different one, from
// different inputs, and two of them could not be wrong in a way anybody would
// notice:
//
//   Settings       "● Connected — changes sync across devices in real time",
//                  rendered from SYNC_ENABLED, a build-time constant. It said
//                  Connected in aeroplane mode. It always said Connected.
//   Home           SyncBadge, from `syncState` alone — the outcome of the LAST
//                  push. 'idle' after two seconds, whatever is still unsent.
//   Live tracker   a paragraph, also from `syncState`, also blind to how much
//                  is waiting.
//
// None of them could distinguish the four situations that need different
// reactions from the person holding the phone:
//
//   connected, nothing waiting      nothing to do
//   connected, sending              nothing to do, briefly
//   offline, N changes waiting      stay in the app, they are safe and queued
//   connected, the server refused   something is actually wrong
//
// The inputs for all four now exist (reachability in sync/connectivity.ts, the
// outbox depth in sync/pendingEvents.ts), so the derivation belongs in one pure
// function rather than in three components' JSX. Pure so the table below is
// covered by tests/sync.test.js instead of by reading it.
//
// The wording rule is the same one the rest of this app follows: say what is
// true and what to do about it, never the server's own words, and never a
// promise about the future that the code does not keep.
// ============================================================================

import { NetStatus } from './connectivity';

/** What the app is doing about the last write it was asked to make. */
export type WriteState = 'idle' | 'saving' | 'saved' | 'error';

export type SyncPhase =
  /** Sync was never configured for this build. Data is device-local, and fine. */
  | 'local-only'
  /** Server unreachable, and everything logged so far is already on it. */
  | 'offline'
  /** Server unreachable, and N local changes are waiting to go up. */
  | 'offline-pending'
  /** Reachable, and a write is on the wire right now. */
  | 'syncing'
  /** Reachable, the last write failed, and changes are still waiting. */
  | 'failed'
  /** Reachable, nothing waiting, and a write landed a moment ago. */
  | 'saved'
  /** Reachable and nothing outstanding. */
  | 'synced';

export type SyncTone = 'ok' | 'warn' | 'bad' | 'muted';

export interface SyncSummary {
  phase: SyncPhase;
  /** Short enough for a badge: two or three words. */
  label: string;
  /**
   * Shorter still — a chip on a row that already has a button on it.
   *
   * The live tracker's version of this was a two-line paragraph in the vertical
   * flow, so a failed write pushed the scoreboard, the controls and the on-court
   * five down the screen. On the one screen where the layout is muscle memory
   * and people are tapping without looking, the warning moved the thing they
   * were aiming at. It sits beside Exit now, in space that was empty, and it
   * cannot reflow anything: this is the label that has to fit there.
   */
  short: string;
  /** One sentence for Settings and for the live tracker's detail modal. */
  detail: string;
  tone: SyncTone;
  /** Local changes not yet known to be on the server. */
  pending: number;
}

export interface SyncInputs {
  /** SYNC_ENABLED — whether this build has a server at all. */
  enabled: boolean;
  net: NetStatus;
  /** Outbox depth: local writes the server has not confirmed. */
  pending: number;
  writeState: WriteState;
  /** Why the last write failed, already worded for a person, or null. */
  lastError: string | null;
}

const plural = (n: number) => (n === 1 ? '1 change' : `${n} changes`);

/**
 * Collapse the four inputs into the one thing a person needs to know.
 *
 * Order matters, and it is deliberately "what is wrong" before "what is fine":
 *
 *   1. no server configured — nothing else applies
 *   2. unreachable          — the reason nothing is moving, waiting or not
 *   3. a failure with work still queued — the only genuinely bad state
 *   4. sending
 *   5. queued but idle      — reachable, so a drain is imminent
 *   6. just saved / settled
 *
 * `pending` beats `writeState` throughout: a green "Saved" for the last tap
 * while nine earlier ones sit unsent is the lie this whole change exists to
 * remove.
 */
export function describeSync(i: SyncInputs): SyncSummary {
  const pending = Math.max(0, i.pending | 0);
  const of = (phase: SyncPhase, label: string, short: string, detail: string, tone: SyncTone): SyncSummary =>
    ({ phase, label, short, detail, tone, pending });

  const safeHere = `${plural(pending)} ${pending === 1 ? 'is' : 'are'} saved on this device`;

  if (!i.enabled) {
    return of('local-only', 'Local only', 'Local',
      'This build has no server configured, so everything stays on this device.', 'muted');
  }

  if (i.net === 'offline') {
    return pending > 0
      ? of('offline-pending', `Offline · ${plural(pending)} waiting`, `Offline · ${pending}`,
        `No connection to the server. ${safeHere} and will be sent automatically as soon as `
        + 'the connection returns, including if you close the app before then.', 'warn')
      : of('offline', 'Offline', 'Offline',
        'No connection to the server. Everything logged so far is already saved on it.', 'warn');
  }

  // Reachable from here down.
  if (i.writeState === 'error' && pending > 0) {
    return of('failed', `Sync failed · ${plural(pending)} waiting`, `Not saved · ${pending}`,
      `${i.lastError ?? 'The server would not accept the change.'} `
      + `${safeHere} and will be retried automatically.`, 'bad');
  }
  if (i.writeState === 'saving' || pending > 0) {
    return of('syncing', pending > 0 ? `Syncing · ${plural(pending)}` : 'Syncing…',
      pending > 0 ? `Sending ${pending}` : 'Sending',
      'Sending changes to the server.', 'ok');
  }
  if (i.writeState === 'saved') {
    return of('saved', 'Saved', 'Saved', 'Everything on this device is saved to the server.', 'ok');
  }
  return of('synced', 'Connected', 'Synced', 'Connected — changes sync across devices in real time.', 'ok');
}
