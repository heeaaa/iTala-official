// ============================================================================
// Is the server reachable right now?
//
// WHY THIS EXISTS
//
// Nothing in this app knew. `synced` — the flag Settings rendered as
// "● Connected" and the flag pull-to-refresh was gated on — is
// `SYNC_ENABLED`, which is `!!(EXPO_PUBLIC_SUPABASE_URL && ANON_KEY)`. That is
// decided when the bundle is built and never changes again. So a device in
// aeroplane mode reported "Connected — changes sync across devices in real
// time", and a pull-to-refresh fired a full five-table read that could only
// fail, swallowed the failure in a `warn`, and spun the spinner back up with no
// explanation. Both are the same missing fact.
//
// WHY REACHABILITY AND NOT "HAS A NETWORK INTERFACE"
//
// The obvious answer is a link-layer library (NetInfo, expo-network). Neither
// is installed, both are native modules — a new native build for every
// developer and every CI lane — and neither answers the question this app
// actually has. A phone on gym wifi behind a captive portal, or on a hotel
// network that has not been accepted yet, reports `isConnected: true` and
// cannot reach Supabase. A stat logged in that state is exactly as lost as one
// logged in aeroplane mode.
//
// So the signal is derived from what the app already does: every request to the
// server is evidence. A request that comes back — even with a row-level
// rejection — proves the host was reached. A request that fails with React
// Native's `TypeError: Network request failed` proves it was not. The
// classification is `isNetworkFailure`, shared with the auth layer, so the two
// cannot disagree about what happened.
//
// The one thing observation alone cannot do is notice that a dead connection
// came back, because a device with nothing to send makes no requests. That is
// what `probe` is for: while offline, the store runs a single cheap read on a
// backoff, and the first one that answers flips the state and drains the
// outbox.
//
// `unknown` is a real third state and not a synonym for online. At launch,
// before anything has been attempted, the app genuinely does not know — and it
// must not tell somebody they are offline on that basis, nor refuse a
// pull-to-refresh they asked for. `unknown` behaves as "try it and find out".
// ============================================================================

import { isNetworkFailure } from '../store/authErrors';

export type NetStatus = 'online' | 'offline' | 'unknown';

let status: NetStatus = 'unknown';
const listeners = new Set<(s: NetStatus) => void>();

/** Last observed reachability. `unknown` until the first request settles. */
export function netStatus(): NetStatus {
  return status;
}

/**
 * True only when the server is KNOWN to be unreachable.
 *
 * The gate for "don't fire a request that cannot succeed". Deliberately false
 * for `unknown`: refusing a user's first pull-to-refresh on a guess is worse
 * than one request that fails and teaches us the answer.
 */
export function isKnownOffline(): boolean {
  return status === 'offline';
}

function set(next: NetStatus): void {
  if (status === next) return;
  status = next;
  // Copied before iterating: a listener is free to unsubscribe itself.
  for (const fn of [...listeners]) fn(next);
}

/** Subscribe to changes. Returns the unsubscribe. Never fires for a no-op set. */
export function subscribeNet(fn: (s: NetStatus) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * A request reached the server. Includes one that came back with a row-level
 * rejection: the host answered, which is the whole question here.
 */
export function noteReachable(): void {
  set('online');
}

/**
 * A request failed. Returns whether it failed because the host was unreachable
 * — the caller usually needs to know that too, to decide between "retry when
 * the connection returns" and "this write will never be accepted".
 *
 * A non-network failure leaves the status alone rather than setting 'online'.
 * It is evidence the host answered, but `noteReachable` is called on the
 * success path already, and a rejected write is not the moment to declare a
 * connection healthy.
 */
export function noteUnreachable(e: unknown): boolean {
  const msg = (e as Error)?.message ?? String(e ?? '');
  const offline = isNetworkFailure(msg);
  if (offline) set('offline');
  else set('online'); // the host answered, it just refused
  return offline;
}

/**
 * Backoff for the recovery probe, in milliseconds, by attempt number (0-based).
 *
 * Short at first so a brief drop out of coverage recovers almost immediately,
 * then capped, so a device left in a lift for an hour is not waking its radio
 * every two seconds. Pure and exported so the schedule is testable without
 * waiting for it.
 */
const PROBE_BACKOFF_MS = [2000, 4000, 8000, 15000, 30000] as const;
export function probeDelay(attempt: number): number {
  const i = Math.min(Math.max(attempt, 0), PROBE_BACKOFF_MS.length - 1);
  return PROBE_BACKOFF_MS[i];
}

/** Test hook: back to a fresh, unobserved connection. */
export function __resetNet(): void {
  status = 'unknown';
  listeners.clear();
}
