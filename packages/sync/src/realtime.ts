/**
 * Applying a realtime change.
 *
 * v1 subscribed to six tables, ignored the payload entirely, and re-downloaded
 * every row of five tables including every base64 logo. It did that on every
 * change, including its own writes echoing back to it.
 *
 * Here the payload IS the change. Applying it is an upsert or a delete, which
 * makes a self-echo harmless: upserting a row we just wrote is a no-op. A
 * periodic full reconcile still runs as a safety net, but it is no longer the
 * mechanism.
 */
import type { Op, Table } from '@itala/domain';
import { rowKey, type Row } from './types';

export interface RealtimeChange {
  table: Table;
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  /** Present for INSERT and UPDATE. */
  new?: Row | null;
  /** For DELETE, Postgres sends only the primary key by default. That is enough. */
  old?: { id?: string } | null;
}

/** Returns the local operation to apply, or null when the change must be ignored. */
export function planRealtime(change: RealtimeChange, pending: Set<string>): Op | null {
  if (change.eventType === 'DELETE') {
    const id = change.old?.id;
    if (!id) return null;
    // Do not delete a row we are in the middle of creating or updating.
    if (pending.has(rowKey(change.table, id))) return null;
    return { op: 'delete', table: change.table, id };
  }

  const row = change.new;
  if (!row || typeof row.id !== 'string') return null;
  if (pending.has(rowKey(change.table, row.id))) return null;
  return { op: 'upsert', table: change.table, row };
}

export const isSyncTable = (t: string): t is Table =>
  t === 'leagues' || t === 'teams' || t === 'players' || t === 'games' || t === 'events';
