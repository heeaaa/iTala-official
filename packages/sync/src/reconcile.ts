/**
 * Reconciling a full remote snapshot against local state.
 *
 * v1's boot sequence replaced the local leagues array wholesale with whatever
 * the server returned. A league created offline, on a device that reconnected
 * before its push succeeded, was destroyed. Worse, any remote change at all
 * triggered the same wholesale replace, so a scorekeeper who logged a quarter
 * of stats in airplane mode could lose them the moment somebody else on
 * another court touched anything.
 *
 * The rule here is simple and absolute: A ROW WITH AN UNSENT OUTBOX ENTRY IS
 * NEVER TOUCHED BY A PULL. The outbox is the record of local intent; until it
 * drains, local wins.
 */
import type { Op, Table } from '@itala/domain';
import { SYNC_TABLES, rowKey, type RemoteSnapshot } from './types';

export interface ReconcilePlan {
  ops: Op[];
  /** Rows left alone because a local write is still in flight. */
  skipped: number;
}

export function planReconcile(
  local: Map<Table, Set<string>>,
  remote: RemoteSnapshot,
  pending: Set<string>,
): ReconcilePlan {
  const ops: Op[] = [];
  let skipped = 0;

  for (const table of SYNC_TABLES) {
    const remoteRows = remote[table as keyof RemoteSnapshot] ?? [];
    const remoteIds = new Set<string>();

    for (const row of remoteRows) {
      remoteIds.add(row.id);
      if (pending.has(rowKey(table, row.id))) {
        skipped++;
        continue;
      }
      ops.push({ op: 'upsert', table, row });
    }

    // Anything held locally that the server no longer has was deleted by
    // another device, UNLESS we are the ones still trying to create it.
    for (const id of local.get(table) ?? []) {
      if (remoteIds.has(id)) continue;
      if (pending.has(rowKey(table, id))) {
        skipped++;
        continue;
      }
      ops.push({ op: 'delete', table, id });
    }
  }

  return { ops, skipped };
}
