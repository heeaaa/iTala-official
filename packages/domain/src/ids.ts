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
 *
 * COLLISION BOUND, stated rather than assumed. The random suffix is one of
 * 36^6 = 2,176,782,336 values, and only ids minted in the SAME millisecond can
 * collide at all. By the birthday approximation, the chance of any collision
 * among n ids in one millisecond is about 1 - exp(-n^2 / 2 * 36^6):
 *
 *      n = 20     ~ 1 in 11 million
 *      n = 200    ~ 1 in 109 thousand
 *      n = 1,000  ~ 1 in 4,400
 *      n = 20,000 ~ 1 in 11          <-- not acceptable
 *
 * The app's real worst case is a drop-in game creating perhaps twenty players
 * in one tick, which sits at the top of that table with room to spare. A bulk
 * import of thousands of records generated in a tight loop would NOT be safe,
 * and would need a counter or a wider suffix. Nothing does that today; if
 * something ever does, this comment is the reason to revisit it.
 */
export const uid = (now: number = Date.now(), random: () => number = Math.random): string =>
  now.toString(36) + random().toString(36).slice(2, 8).padEnd(6, '0');

/** Shape check only. Used to reject obvious junk at trust boundaries. */
export const looksLikeId = (v: unknown): v is string =>
  typeof v === 'string' && v.length >= 8 && v.length <= 32 && /^[0-9a-z]+$/.test(v);
