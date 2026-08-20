/**
 * The outbox drainer.
 *
 * Strict FIFO by sequence number, because the order is causal: a league exists
 * before its teams, a team before its players, a game before its events. A
 * retryable failure stops the drain rather than skipping ahead, so a
 * dependency can never be delivered after its dependant.
 */
import type { LocalStore, RemoteClient } from './types.js';
import { DEFAULT_BACKOFF, backoffDelay, type BackoffOptions } from './backoff.js';

export interface DrainOptions {
  /** Entries to attempt in one pass. Keeps a huge backlog from blocking the UI. */
  batch: number;
  backoff: BackoffOptions;
  random: () => number;
}

export const DEFAULT_DRAIN: DrainOptions = {
  batch: 50,
  backoff: DEFAULT_BACKOFF,
  random: Math.random,
};

export interface DrainReport {
  sent: number;
  /** Primary-key conflicts. The row was already on the server, which is success. */
  duplicates: number;
  /** Refused for good: authorisation, a constraint violation, malformed data. */
  rejected: number;
  /** Scheduled for another attempt. */
  deferred: number;
  /** True when the drain stopped early because the head of the queue failed. */
  blocked: boolean;
  pending: number;
}

export async function drainOnce(
  store: LocalStore,
  remote: RemoteClient,
  now: number,
  options: Partial<DrainOptions> = {},
): Promise<DrainReport> {
  const opts: DrainOptions = { ...DEFAULT_DRAIN, ...options };
  const report: DrainReport = {
    sent: 0,
    duplicates: 0,
    rejected: 0,
    deferred: 0,
    blocked: false,
    pending: 0,
  };

  const batch = await store.head(opts.batch);

  for (const entry of batch) {
    // Not due yet. STOP rather than skip: everything behind this entry may
    // depend on it, so delivering the queue out of order is worse than
    // delivering it late.
    if (entry.nextAttemptAt > now) {
      report.blocked = true;
      break;
    }

    const result = await remote.send(entry.op);

    if (result.status === 'ok') {
      await store.ack(entry.seq);
      report.sent++;
      continue;
    }

    if (result.status === 'duplicate') {
      // An event insert that conflicts on the primary key means this exact
      // stat is already on the server exactly once. That is the guard that
      // makes replaying the outbox safe, and it is why events are inserted
      // rather than upserted.
      await store.ack(entry.seq);
      report.duplicates++;
      continue;
    }

    if (result.status === 'rejected') {
      // Retrying will never help: an RLS refusal, a constraint violation, a
      // reference to something that does not exist. Move it aside and keep
      // going, but make sure the count reaches the user.
      await store.reject(entry.seq, result.message);
      report.rejected++;
      continue;
    }

    // Retryable. Stop the whole drain to preserve causal order.
    const delay = backoffDelay(entry.attempts, opts.backoff, opts.random);
    await store.retryLater(entry.seq, now + delay, result.message);
    report.deferred++;
    report.blocked = true;
    break;
  }

  report.pending = (await store.counts()).pending;
  return report;
}
