/**
 * In-memory adapters. They implement the same contracts as the real SQLite and
 * Supabase adapters, so the sync engine under test is the exact code that
 * ships. Only the edges are fake.
 */
import type { Op, Table } from '@itala/domain';
import type {
  LocalStore,
  OutboxEntry,
  RemoteClient,
  RemoteResult,
  RemoteSnapshot,
  Row,
} from '../index';
import { SYNC_TABLES, opKey } from '../index';

const emptyTables = (): Map<Table, Map<string, Row>> =>
  new Map(SYNC_TABLES.map((t) => [t, new Map<string, Row>()]));

function applyTo(tables: Map<Table, Map<string, Row>>, op: Op): void {
  const tbl = tables.get(op.table);
  if (!tbl) return;
  if (op.op === 'delete') tbl.delete(op.id);
  else tbl.set(String(op.row['id']), op.row as Row);
}

export class MemoryStore implements LocalStore {
  tables = emptyTables();
  outbox: OutboxEntry[] = [];
  rejected: { entry: OutboxEntry; message: string }[] = [];
  private nextSeq = 1;

  async commit(ops: Op[], outbox: Op[], now: number): Promise<void> {
    // Atomic in the real adapter: one SQLite transaction covering both.
    for (const op of ops) applyTo(this.tables, op);
    for (const op of outbox) {
      this.outbox.push({
        seq: this.nextSeq++,
        op,
        attempts: 0,
        nextAttemptAt: now,
        lastError: null,
      });
    }
  }

  async applyRemote(ops: Op[]): Promise<void> {
    for (const op of ops) applyTo(this.tables, op);
  }

  async head(limit: number): Promise<OutboxEntry[]> {
    return [...this.outbox].sort((a, b) => a.seq - b.seq).slice(0, limit);
  }

  async ack(seq: number): Promise<void> {
    this.outbox = this.outbox.filter((e) => e.seq !== seq);
  }

  async retryLater(seq: number, nextAttemptAt: number, message: string): Promise<void> {
    const e = this.outbox.find((x) => x.seq === seq);
    if (!e) return;
    e.attempts++;
    e.nextAttemptAt = nextAttemptAt;
    e.lastError = message;
  }

  async reject(seq: number, message: string): Promise<void> {
    const e = this.outbox.find((x) => x.seq === seq);
    if (!e) return;
    this.outbox = this.outbox.filter((x) => x.seq !== seq);
    this.rejected.push({ entry: e, message });
  }

  async pendingKeys(): Promise<Set<string>> {
    return new Set(this.outbox.map((e) => opKey(e.op)));
  }

  async counts(): Promise<{ pending: number; rejected: number }> {
    return { pending: this.outbox.length, rejected: this.rejected.length };
  }

  async localIds(): Promise<Map<Table, Set<string>>> {
    return new Map(SYNC_TABLES.map((t) => [t, new Set(this.tables.get(t)?.keys() ?? [])]));
  }

  count(table: Table): number {
    return this.tables.get(table)?.size ?? 0;
  }

  has(table: Table, id: string): boolean {
    return this.tables.get(table)?.has(id) ?? false;
  }
}

/** A shared server that several MemoryStore-backed devices can talk to. */
export class FakeServer {
  tables = emptyTables();

  count(table: Table): number {
    return this.tables.get(table)?.size ?? 0;
  }

  snapshot(): RemoteSnapshot {
    const of = (t: Table): Row[] => [...(this.tables.get(t)?.values() ?? [])];
    return {
      leagues: of('leagues'),
      teams: of('teams'),
      players: of('players'),
      games: of('games'),
      events: of('events'),
    };
  }
}

export class FakeRemote implements RemoteClient {
  online = true;
  /** Return a permanent refusal for any op this matches, as RLS would. */
  refuse: ((op: Op) => boolean) | null = null;
  sent: Op[] = [];

  constructor(private server: FakeServer) {}

  async send(op: Op): Promise<RemoteResult> {
    if (!this.online) return { status: 'retry', message: 'network unreachable' };
    if (this.refuse?.(op)) {
      return { status: 'rejected', message: 'new row violates row-level security policy' };
    }
    this.sent.push(op);

    // Events are inserted, not upserted, so a replay hits the primary key.
    if (op.op === 'insert') {
      const id = String(op.row['id']);
      if (this.server.tables.get(op.table)?.has(id)) return { status: 'duplicate' };
    }
    applyTo(this.server.tables, op);
    return { status: 'ok' };
  }

  async fetchAll(): Promise<RemoteSnapshot | null> {
    if (!this.online) return null;
    return this.server.snapshot();
  }
}
