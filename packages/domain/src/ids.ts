/**
 * ID generation.
 *
 * Base-36 epoch milliseconds followed by 6 characters of base-36 randomness.
 * 14 characters today. Two properties matter and are deliberate:
 *
 *  1. IDs are generated on the CLIENT, before any network call, so a record
 *     created offline has its permanent identity immediately and syncs cleanly.
 *  2. The timestamp prefix makes IDs lexicographically sortable by creation
 *     time, which is free and occasionally useful.
 *
 * These are not secrets and they are not enumerable across tenants (there is
 * one tenant), so Math.random is fine here.
 */
export const uid = (now: number = Date.now()): string =>
  now.toString(36) + Math.random().toString(36).slice(2, 8);

/** Shape check only. Used to reject obvious junk at trust boundaries. */
export const looksLikeId = (v: unknown): v is string =>
  typeof v === 'string' && v.length >= 8 && v.length <= 32 && /^[0-9a-z]+$/.test(v);
