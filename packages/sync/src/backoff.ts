/**
 * Retry schedule for the outbox.
 *
 * v1 had no retries at all: a failed push was logged to the console and
 * dropped, and the local state silently diverged from the server until
 * somebody else's change happened to trigger a full refetch. The whole promise
 * of this app is "never lose a game", so a write that cannot be delivered has
 * to keep trying and, if it truly cannot be delivered, has to be visible.
 */
export interface BackoffOptions {
  /** First retry delay. */
  baseMs: number;
  /** Ceiling, so a long outage does not push the next attempt into next week. */
  maxMs: number;
  /**
   * Fraction of the delay to randomise, 0 to 1. Without jitter every device
   * that lost the same wifi retries in lockstep the moment it returns.
   * Injected rather than read from Math.random so tests stay deterministic.
   */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 1_000,
  maxMs: 60_000,
  jitter: 0.25,
};

/** Exponential with a ceiling, then jittered downward by up to `jitter`. */
export function backoffDelay(
  attempts: number,
  opts: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exp = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.max(0, attempts));
  const spread = exp * opts.jitter;
  return Math.max(0, Math.round(exp - spread * random()));
}
