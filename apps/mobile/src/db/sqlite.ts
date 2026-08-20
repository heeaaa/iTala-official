/**
 * The local store, on SQLite.
 *
 * v1 serialised the ENTIRE state tree, including every base64 team logo, to
 * AsyncStorage after every single mutation. At this app's target scale (a
 * league of 40 teams and 20 games) that is megabytes rewritten per stat tap,
 * on an iPad, mid-game.
 *
 * Here a stat is one row insert. Just as importantly, the domain rows and the
 * outbox entry are written in ONE TRANSACTION, so it is not possible to have
 * applied a change locally without also having recorded the intent to send it.
 * That single property is what makes the "never lose a game" promise true.
 *
 * Rows are stored as JSON keyed by id rather than as a column per field. The
 * local database is a cache, not a query surface: everything is projected into
 * memory and derived from there. Keeping rows opaque means the local and
 * remote shapes stay identical by construction, which removes the whole class
 * of quiet coercion bugs v1's hand-written row mappers carried.
 */
import * as SQLite from 'expo-sqlite';
import type { Op, Table } from '@itala/domain';
import type { LocalStore, OutboxEntry, Row } from '@itala/sync';
import { SYNC_TABLES, opKey } from '@itala/sync';

const DB_NAME = 'itala.db';

interface RowRecord {
  id: string;
  data: string;
}

interface OutboxRecord {
  seq: number;
  op: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
}

const SCHEMA = `
pragma journal_mode = WAL;
pragma foreign_keys = off;

${SYNC_TABLES.map(
  (t) => `
create table if not exists ${t} (
  id        text primary key,
  league_id text,
  data      text not null
);
create index if not exists ${t}_league_idx on ${t}(league_id);`,
).join('\n')}

-- Unsent local intent. Drains in seq order; the order is causal.
create table if not exists outbox (
  seq             integer primary key autoincrement,
  op              text    not null,
  row_key         text    not null,
  attempts        integer not null default 0,
  next_attempt_at integer not null,
  last_error      text
);
create index if not exists outbox_key_idx on outbox(row_key);

-- Writes the server refused for good. Kept rather than dropped, so the count
-- can reach the user and somebody can find out what happened.
create table if not exists outbox_rejected (
  seq         integer primary key,
  op          text    not null,
  message     text    not null,
  rejected_at integer not null
);
`;

export async function openLocalDb(name = DB_NAME): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(name);
  await db.execAsync(SCHEMA);
  return db;
}

const leagueIdOf = (op: Op): string | null => {
  if (op.op === 'delete') return null;
  if (op.table === 'leagues') return String(op.row['id']);
  const v = op.row['league_id'];
  return typeof v === 'string' ? v : null;
};

export class SqliteStore implements LocalStore {
  constructor(private db: SQLite.SQLiteDatabase) {}

  private async applyOp(op: Op): Promise<void> {
    if (op.op === 'delete') {
      await this.db.runAsync(`delete from ${op.table} where id = ?`, op.id);
      return;
    }
    await this.db.runAsync(
      `insert into ${op.table} (id, league_id, data) values (?, ?, ?)
         on conflict(id) do update set league_id = excluded.league_id, data = excluded.data`,
      String(op.row['id']),
      leagueIdOf(op),
      JSON.stringify(op.row),
    );
  }

  /** Domain rows and outbox entries land together or not at all. */
  async commit(ops: Op[], outbox: Op[], now: number): Promise<void> {
    await this.db.withTransactionAsync(async () => {
      for (const op of ops) await this.applyOp(op);
      for (const op of outbox) {
        await this.db.runAsync(
          `insert into outbox (op, row_key, attempts, next_attempt_at, last_error)
           values (?, ?, 0, ?, null)`,
          JSON.stringify(op),
          opKey(op),
          now,
        );
      }
    });
  }

  async applyRemote(ops: Op[]): Promise<void> {
    if (ops.length === 0) return;
    await this.db.withTransactionAsync(async () => {
      for (const op of ops) await this.applyOp(op);
    });
  }

  async head(limit: number): Promise<OutboxEntry[]> {
    const rows = await this.db.getAllAsync<OutboxRecord>(
      `select seq, op, attempts, next_attempt_at, last_error
         from outbox order by seq asc limit ?`,
      limit,
    );
    return rows.map((r) => ({
      seq: r.seq,
      op: JSON.parse(r.op) as Op,
      attempts: r.attempts,
      nextAttemptAt: r.next_attempt_at,
      lastError: r.last_error,
    }));
  }

  async ack(seq: number): Promise<void> {
    await this.db.runAsync('delete from outbox where seq = ?', seq);
  }

  async retryLater(seq: number, nextAttemptAt: number, message: string): Promise<void> {
    await this.db.runAsync(
      'update outbox set attempts = attempts + 1, next_attempt_at = ?, last_error = ? where seq = ?',
      nextAttemptAt,
      message,
      seq,
    );
  }

  async reject(seq: number, message: string): Promise<void> {
    await this.db.withTransactionAsync(async () => {
      const rows = await this.db.getAllAsync<OutboxRecord>(
        'select seq, op, attempts, next_attempt_at, last_error from outbox where seq = ?',
        seq,
      );
      const entry = rows[0];
      if (entry) {
        await this.db.runAsync(
          'insert or replace into outbox_rejected (seq, op, message, rejected_at) values (?, ?, ?, ?)',
          entry.seq,
          entry.op,
          message,
          Date.now(),
        );
      }
      await this.db.runAsync('delete from outbox where seq = ?', seq);
    });
  }

  async pendingKeys(): Promise<Set<string>> {
    const rows = await this.db.getAllAsync<{ row_key: string }>('select row_key from outbox');
    return new Set(rows.map((r) => r.row_key));
  }

  async counts(): Promise<{ pending: number; rejected: number }> {
    const p = await this.db.getAllAsync<{ n: number }>('select count(*) as n from outbox');
    const r = await this.db.getAllAsync<{ n: number }>('select count(*) as n from outbox_rejected');
    return { pending: p[0]?.n ?? 0, rejected: r[0]?.n ?? 0 };
  }

  async localIds(): Promise<Map<Table, Set<string>>> {
    const out = new Map<Table, Set<string>>();
    for (const t of SYNC_TABLES) {
      const rows = await this.db.getAllAsync<{ id: string }>(`select id from ${t}`);
      out.set(t, new Set(rows.map((r) => r.id)));
    }
    return out;
  }

  /** Every row, for rebuilding the in-memory projection. */
  async readAll(): Promise<Record<Table, Row[]>> {
    const out = {} as Record<Table, Row[]>;
    for (const t of SYNC_TABLES) {
      const rows = await this.db.getAllAsync<RowRecord>(`select data from ${t}`);
      out[t] = rows.map((r) => JSON.parse(r.data) as Row);
    }
    return out;
  }

  async rejectedEntries(): Promise<{ seq: number; op: Op; message: string }[]> {
    const rows = await this.db.getAllAsync<{ seq: number; op: string; message: string }>(
      'select seq, op, message from outbox_rejected order by seq asc',
    );
    return rows.map((r) => ({ seq: r.seq, op: JSON.parse(r.op) as Op, message: r.message }));
  }
}
