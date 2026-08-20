/**
 * The Supabase side of the sync contract.
 *
 * The whole job here is classifying what the server said into three buckets,
 * because getting that wrong is how writes get lost:
 *
 *   retry     a network blip, a timeout, a rate limit, a 5xx. Try forever.
 *   rejected  authorisation, a constraint, a missing reference. Never succeeds.
 *   duplicate a primary-key conflict on an event insert. Already safely there.
 *
 * v1 made no distinction at all: everything was logged to the console and
 * dropped on the floor.
 */
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import type { Op } from '@itala/domain';
import type { RemoteClient, RemoteResult, RemoteSnapshot, Row } from '@itala/sync';
import { TIMEOUTS, withTimeout } from './client';

/** Postgres SQLSTATEs we can reason about. */
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
const NOT_NULL_VIOLATION = '23502';
const RLS_VIOLATION = '42501';

const PERMANENT = new Set([
  FOREIGN_KEY_VIOLATION,
  CHECK_VIOLATION,
  NOT_NULL_VIOLATION,
  RLS_VIOLATION,
]);

function classify(error: PostgrestError | null, isInsert: boolean): RemoteResult {
  if (!error) return { status: 'ok' };

  if (isInsert && error.code === UNIQUE_VIOLATION) return { status: 'duplicate' };
  if (error.code && PERMANENT.has(error.code)) {
    return { status: 'rejected', message: error.message };
  }
  // PostgREST reports authorisation failures without a SQLSTATE sometimes.
  if (/row-level security|permission denied|JWT/i.test(error.message ?? '')) {
    return { status: 'rejected', message: error.message };
  }
  // Anything else, including every network and server error, is worth retrying.
  return { status: 'retry', message: error.message || 'unknown error' };
}

const TIMED_OUT: RemoteResult = { status: 'retry', message: 'request timed out' };

export class SupabaseRemote implements RemoteClient {
  constructor(private sb: SupabaseClient) {}

  async send(op: Op): Promise<RemoteResult> {
    if (op.op === 'delete') {
      const res = await withTimeout(
        this.sb.from(op.table).delete().eq('id', op.id),
        TIMEOUTS.push,
        null,
        `delete ${op.table}`,
      );
      if (!res) return TIMED_OUT;
      return classify(res.error, false);
    }

    if (op.op === 'insert') {
      const res = await withTimeout(
        this.sb.from(op.table).insert(op.row),
        TIMEOUTS.push,
        null,
        `insert ${op.table}`,
      );
      if (!res) return TIMED_OUT;
      return classify(res.error, true);
    }

    const res = await withTimeout(
      this.sb.from(op.table).upsert(op.row),
      TIMEOUTS.push,
      null,
      `upsert ${op.table}`,
    );
    if (!res) return TIMED_OUT;
    return classify(res.error, false);
  }

  async fetchAll(): Promise<RemoteSnapshot | null> {
    const q = <T extends string>(table: T) =>
      withTimeout(this.sb.from(table).select('*'), TIMEOUTS.pull, null, `select ${table}`);

    const [leagues, teams, players, games, events] = await Promise.all([
      q('leagues'),
      q('teams'),
      q('players'),
      q('games'),
      q('events'),
    ]);

    // A partial snapshot is worse than none: reconciling against it would
    // delete every row of whichever table failed. All or nothing.
    const parts = [leagues, teams, players, games, events];
    for (const p of parts) {
      if (!p || p.error) {
        if (p?.error) console.warn('[itala] pull failed:', p.error.message);
        return null;
      }
    }

    const rows = (r: { data: unknown } | null): Row[] => (r?.data as Row[] | null) ?? [];
    return {
      leagues: rows(leagues),
      teams: rows(teams),
      players: rows(players),
      games: rows(games),
      events: rows(events),
    };
  }
}
