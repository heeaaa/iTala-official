// A small PostgREST/Supabase emulator for the sync tests.
//
// It is deliberately just enough to run src/sync/sync.ts against: the table
// builder shapes the client actually uses (.select().order(), .eq().maybeSingle(),
// .insert(), .upsert(), .delete().eq(), and .delete().eq().select()), plus the
// RPCs the sync layer calls.
//
// The two things it models that a live project does and a naive stub does not:
//
//   1. PER-OPERATION LATENCY. Real requests to the same table can be applied by
//      the server in a different order than the client issued them. `latency`
//      lets a test make a DELETE overtake an INSERT, which is the ordering the
//      "undo a mis-tap immediately" race produces on a flaky gym connection.
//   2. RLS AS A SILENT FILTER. PostgREST does not error when row-level security
//      hides the rows a DELETE targeted - it succeeds and removes nothing. So a
//      rejected delete looks identical to a successful one unless the client
//      asks for the deleted rows back.

'use strict';

const TABLES = ['leagues', 'teams', 'players', 'games', 'events'];

function clone(x) { return x === undefined ? x : JSON.parse(JSON.stringify(x)); }

class FakeServer {
  constructor() {
    this.rows = {};
    for (const t of TABLES) this.rows[t] = [];
    this.log = [];
    // op -> ms. op looks like 'insert:events' or 'delete:events'.
    this.latency = {};
    // op -> 'network' | { message }. 'network' throws the TypeError React
    // Native's fetch throws when it cannot reach the host, which is what a
    // scorekeeper on a dropped gym connection actually gets; an object comes
    // back as a PostgREST error instead. Needed because a push that REJECTS and
    // a push that succeeds must leave the ledger in different states.
    this.failures = {};
    // table -> predicate(row, op). Return false to hide the row from writes,
    // emulating RLS. Hidden rows are silently skipped, never an error.
    this.rls = {};
  }

  delayFor(op) { return this.latency[op] ?? 0; }

  visible(table, row, op) {
    const p = this.rls[table];
    return p ? !!p(row, op) : true;
  }

  // The whole device loses its connection, not one table.
  //
  // Every existing failure in this harness is per-operation, which is right for
  // "the server refused THIS write" and useless for "there is no network". An
  // offline device fails every read and every write identically, and the
  // difference matters: the outbox, the reachability signal and the drain all
  // key off a TRANSPORT failure rather than a rejection.
  //
  // Deliberately leaves any per-op failure already set: a suite that combines
  // an RLS rejection with a connection drop is testing something real.
  offline(on = true) {
    const ops = ['select', 'insert', 'upsert', 'delete'];
    const rpcs = ['create_league', 'add_player', 'rec_setup_game', 'bulk_import_roster'];
    const keys = [
      ...TABLES.flatMap(t => ops.map(op => `${op}:${t}`)),
      ...rpcs.map(r => `rpc:${r}`),
    ];
    for (const k of keys) {
      if (on) this.failures[k] = 'network';
      else if (this.failures[k] === 'network') delete this.failures[k];
    }
  }

  count(table) { return this.rows[table].length; }
  find(table, id) { return this.rows[table].find(r => r.id === id); }
  has(table, id) { return !!this.find(table, id); }
}

const wait = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());

// A thenable query builder. Every terminal await goes through `settle`, which
// applies the operation's latency first so ordering can be manipulated.
function makeBuilder(server, table, op, payload) {
  const filters = [];
  let wantSingle = false;
  let wantReturning = false;
  const orderBy = [];

  const apply = () => {
    server.log.push({ op, table, payload: clone(payload), filters: clone(filters) });
    const matches = row => filters.every(f => row[f.col] === f.val);

    if (op === 'select') {
      let data = server.rows[table].filter(matches).map(clone);
      // PostgREST applies .order() calls left to right, so a second one breaks
      // ties left by the first. The events query relies on that: .order('ts')
      // .order('id') is what makes row order total rather than arbitrary within
      // a millisecond. Modelling only the first key would let this suite pass
      // while the real server still shuffled tied rows.
      if (orderBy.length) {
        data.sort((a, b) => {
          for (const { col, ascending } of orderBy) {
            const av = a[col], bv = b[col];
            if (av === bv) continue;
            if (av === null || av === undefined) return 1;
            if (bv === null || bv === undefined) return -1;
            return (av < bv ? -1 : 1) * (ascending ? 1 : -1);
          }
          return 0;
        });
      }
      if (wantSingle) return { data: data[0] ?? null, error: null };
      return { data, error: null };
    }

    if (op === 'insert' || op === 'upsert') {
      const incoming = Array.isArray(payload) ? payload : [payload];
      const written = [];
      for (const r of incoming) {
        if (!server.visible(table, r, op)) continue; // RLS: silently skipped
        const existing = server.rows[table].findIndex(x => x.id === r.id);
        if (existing >= 0) {
          if (op === 'insert') {
            return { data: null, error: { message: `duplicate key value violates unique constraint "${table}_pkey"` } };
          }
          server.rows[table][existing] = clone(r);
        } else {
          server.rows[table].push(clone(r));
        }
        written.push(clone(r));
      }
      return { data: wantReturning ? written : null, error: null };
    }

    if (op === 'delete') {
      const removed = [];
      server.rows[table] = server.rows[table].filter(row => {
        if (!matches(row)) return true;
        if (!server.visible(table, row, 'delete')) return true; // RLS: silently kept
        removed.push(clone(row));
        return false;
      });
      return { data: wantReturning ? removed : null, error: null };
    }

    throw new Error(`fakeSupabase: unsupported op ${op}`);
  };

  const settle = async () => {
    await wait(server.delayFor(`${op}:${table}`));
    const f = server.failures[`${op}:${table}`];
    if (f === 'network') throw new TypeError('Network request failed');
    if (f) return { data: null, error: { message: f.message || String(f) } };
    return apply();
  };

  const builder = {
    eq(col, val) { filters.push({ col, val }); return builder; },
    order(col, opts) { orderBy.push({ col, ascending: opts?.ascending !== false }); return builder; },
    select() { wantReturning = true; return builder; },
    // PostgREST's row cap. pingServer uses it for the cheapest possible read;
    // the emulator only has to accept it, because no assertion here depends on
    // the row count coming back.
    limit() { return builder; },
    maybeSingle() { wantSingle = true; return builder; },
    single() { wantSingle = true; return builder; },
    then(res, rej) { return settle().then(res, rej); },
    catch(rej) { return settle().catch(rej); },
  };
  return builder;
}

function makeClient(server) {
  return {
    from(table) {
      if (!TABLES.includes(table)) throw new Error(`fakeSupabase: unknown table ${table}`);
      return {
        select(_cols) { return makeBuilder(server, table, 'select'); },
        insert(payload) { return makeBuilder(server, table, 'insert', payload); },
        upsert(payload) { return makeBuilder(server, table, 'upsert', payload); },
        update(payload) { return makeBuilder(server, table, 'upsert', payload); },
        delete() { return makeBuilder(server, table, 'delete'); },
      };
    },
    async rpc(name, args) {
      await wait(server.delayFor(`rpc:${name}`));
      server.log.push({ op: 'rpc', name, payload: clone(args) });
      const f = server.failures[`rpc:${name}`];
      if (f === 'network') throw new TypeError('Network request failed');
      if (f) return { data: null, error: { message: f.message || String(f) } };
      switch (name) {
        case 'create_league':
          if (!server.has('leagues', args.p_id)) {
            server.rows.leagues.push({
              id: args.p_id, name: args.p_name, season: args.p_season, kind: args.p_kind,
              foul_out_limit: args.p_foul_out, track_misses: args.p_track_misses,
              track_turnovers: args.p_track_turnovers, is_shared: args.p_shared,
              is_closed: null, is_archived: null, created_at: args.p_created_at,
            });
          }
          return { data: true, error: null };
        case 'add_player': {
          if (!server.has('players', args.p_player_id)) {
            server.rows.players.push({
              id: args.p_player_id, league_id: args.p_league_id, name: args.p_name,
              number: args.p_number, origin_player_id: null,
            });
          }
          const t = server.find('teams', args.p_team_id);
          if (t && !t.player_ids.includes(args.p_player_id)) t.player_ids.push(args.p_player_id);
          return { data: true, error: null };
        }
        default:
          return { data: true, error: null };
      }
    },
    channel() {
      const ch = { on() { return ch; }, subscribe() { return ch; } };
      return ch;
    },
    removeChannel() {},
  };
}

module.exports = { FakeServer, makeClient, TABLES };
