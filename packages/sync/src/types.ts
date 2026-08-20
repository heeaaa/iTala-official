/**
 * The sync contract.
 *
 * Everything in this package is pure logic behind two injected adapters, so
 * the whole engine can be tested with in-memory fakes and no Expo, no network
 * and no database. That matters: this is where v1's four worst defects lived
 * (undo not syncing, dangling on-court ids, no offline recovery, and a remote
 * pull destroying local work), and none of them were reachable by a test.
 */
import type { Op, Table } from '@itala/domain';

export type Row = Record<string, unknown> & { id: string };

/** A row's identity across the whole system. */
export const rowKey = (table: Table, id: string): string => `${table}:${id}`;

export const opKey = (op: Op): string =>
  op.op === 'delete' ? rowKey(op.table, op.id) : rowKey(op.table, String(op.row['id']));

export interface OutboxEntry {
  /** Monotonic. Entries drain in this order and ordering is causal. */
  seq: number;
  op: Op;
  attempts: number;
  /** Epoch ms. The drainer skips entries scheduled in the future. */
  nextAttemptAt: number;
  lastError: string | null;
}

/**
 * What the remote said. The distinction between retryable and not is the whole
 * game: a network blip must be retried forever, an authorisation refusal must
 * not be, and a primary-key conflict on an event insert means the stat is
 * already safely on the server.
 */
export type RemoteResult =
  | { status: 'ok' }
  | { status: 'duplicate' }
  | { status: 'retry'; message: string }
  | { status: 'rejected'; message: string };

export interface RemoteSnapshot {
  leagues: Row[];
  teams: Row[];
  players: Row[];
  games: Row[];
  events: Row[];
}

export interface RemoteClient {
  send(op: Op): Promise<RemoteResult>;
  fetchAll(): Promise<RemoteSnapshot | null>;
}

export interface LocalStore {
  /** Applies rows locally. Must be atomic with the enqueue that accompanies it. */
  commit(ops: Op[], outbox: Op[], now: number): Promise<void>;
  /** Applies rows locally with NO outbox entries. Used for inbound remote changes. */
  applyRemote(ops: Op[]): Promise<void>;
  /**
   * The next `limit` unsent entries in strict seq order, REGARDLESS of their
   * schedule. The drainer decides what is due.
   *
   * It must not filter by nextAttemptAt: doing so lets a deferred entry be
   * skipped while later ones proceed, which would deliver a team before the
   * league it belongs to. Ordering here is causal, not a preference.
   */
  head(limit: number): Promise<OutboxEntry[]>;
  ack(seq: number): Promise<void>;
  retryLater(seq: number, nextAttemptAt: number, message: string): Promise<void>;
  reject(seq: number, message: string): Promise<void>;
  /** Row keys with an unsent outbox entry. A remote pull must not clobber these. */
  pendingKeys(): Promise<Set<string>>;
  counts(): Promise<{ pending: number; rejected: number }>;
  /** Every row id currently held locally, per table. */
  localIds(): Promise<Map<Table, Set<string>>>;
}

export const SYNC_TABLES: Table[] = ['leagues', 'teams', 'players', 'games', 'events'];
