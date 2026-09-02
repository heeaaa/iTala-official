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
    // op -> 'network' | 'network-resolved' | { message }.
    //
    // THE TWO SHAPES A LOST CONNECTION CAN TAKE, AND WHY BOTH ARE HERE.
    //
    // 'network-resolved' is what the INSTALLED client does, and it is the one
    // that matters. @supabase/postgrest-js catches the fetch rejection and
    // RESOLVES with `{ data: null, error, status: 0 }`; nothing in src/ calls
    // throwOnError() and getSupabase() installs no custom fetch, so this is the
    // shape the app really sees. Verified against this repository's own
    // node_modules: a select and an upsert against an unreachable host both
    // resolve with status 0 and `error.message` of 'TypeError: fetch failed'.
    //
    // 'network' THROWS instead. That is what this harness did for every offline
    // test, and it is why the suite was green on code that could not work: the
    // emulator rejected where production resolves, so `check`'s swallow - the
    // actual defect - was never exercised. It is kept because a rejection is
    // still reachable (a client with a custom fetch, an older transport), and
    // because the two must leave the ledger in the same state.
    //
    // An object comes back as an ordinary PostgREST row-level error, with no
    // status, so nothing classifies it as a transport failure.
    this.failures = {};
    // POSTGREST'S SILENT ROW CAP.
    //
    // PostgREST refuses to return more rows than `db-max-rows`, and Supabase
    // sets that to 1000 by default. It does NOT report the truncation: the
    // response is an ordinary success carrying a short array, with no error and
    // nothing to distinguish it from a table that really does hold that many
    // rows. A client with no pagination therefore reads a snapshot it believes
    // is complete and is not.
    //
    // `null` means unlimited, which is what every existing test wants and what
    // this harness has always done. A suite that cares asks for the cap.
    this.maxRows = null;
    // Called immediately BEFORE a read is served, with the table and how many
    // reads of that table have already been served. A paged read is several
    // requests, and this is the only honest place to model the table changing
    // between two of them - which is what OFFSET paging cannot survive. A test
    // that tries to do it by wrapping the query builder silently does nothing:
    // .order() and .limit() return the real closure-bound builder, so any
    // override spread onto it is dropped on the next chained call.
    // Leagues this account runs, as my_memberships() would report them.
    this.memberships = [];
    this.beforeRead = null;
    this.readCounts = {};
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
  //
  // `mode` DEFAULTS TO 'resolve', because that is what the installed client
  // does. A test that wants the rejecting transport asks for it by name.
  offline(on = true, mode = 'resolve') {
    const ops = ['select', 'insert', 'upsert', 'delete'];
    const rpcs = ['create_league', 'add_player', 'rec_setup_game', 'bulk_import_roster'];
    const keys = [
      ...TABLES.flatMap(t => ops.map(op => `${op}:${t}`)),
      ...rpcs.map(r => `rpc:${r}`),
    ];
    const want = mode === 'throw' ? 'network' : 'network-resolved';
    for (const k of keys) {
      if (on) this.failures[k] = want;
      else if (this.failures[k] === 'network' || this.failures[k] === 'network-resolved') delete this.failures[k];
    }
  }

  count(table) { return this.rows[table].length; }
  find(table, id) { return this.rows[table].find(r => r.id === id); }
  has(table, id) { return !!this.find(table, id); }
}

const wait = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());

// What the INSTALLED client hands back when the request never left the device:
// resolved, not rejected. `status: 0` is the discriminator - postgrest-js sets
// it in exactly one place, the branch that catches the fetch rejection, so it
// is the one field that cannot be confused with a row-level rejection.
const transportResolved = () => ({
  data: null,
  error: { message: 'TypeError: Network request failed', details: '', hint: '', code: '' },
  count: null,
  status: 0,
  statusText: '',
});

// A thenable query builder. Every terminal await goes through `settle`, which
// applies the operation's latency first so ordering can be manipulated.
function makeBuilder(server, table, op, payload, selectOpts) {
  const filters = [];
  let wantSingle = false;
  let wantReturning = false;
  const orderBy = [];
  // .range(from, to) is INCLUSIVE at both ends, as PostgREST's Range header is.
  let limitN = null;
  let rangeFrom = 0;
  let rangeTo = null;
  // .select('*', { count: 'exact' }) asks for the TOTAL number of matching rows
  // regardless of the window - PostgREST reports it in the Content-Range header
  // and postgrest-js surfaces it as `count`. It is deliberately NOT capped by
  // maxRows: the cap limits the reply, not the count, which is the whole reason
  // a client can use it to tell a truncated page from the end of the table.
  let wantCount = selectOpts ? selectOpts.count === 'exact' : false;

  const apply = () => {
    server.log.push({ op, table, payload: clone(payload), filters: clone(filters) });
    if (op === 'select' && typeof server.beforeRead === 'function') {
      const n = server.readCounts[table] || 0;
      server.readCounts[table] = n + 1;
      server.beforeRead(table, n);
    }
    // PostgREST operators, as far as this client uses them. `gt` is what makes
    // keyset paging expressible: the pull walks `id` with .gt('id', cursor).
    const matches = row => filters.every(f =>
      f.op === 'gt' ? row[f.col] > f.val
        : f.op === 'in' ? f.val.includes(row[f.col])
          : row[f.col] === f.val);
    // An `eq` filter carries no `op`, deliberately: assertions elsewhere in the
    // suite compare the recorded filter log field for field.

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
      const total = data.length;
      // The window first, then the cap - the order PostgREST applies them in.
      // Because the cap lands AFTER the ordering, an ascending order plus a cap
      // silently drops the NEWEST rows, which is the shape that costs a
      // scorekeeper the game they have just finished scoring.
      if (rangeFrom > 0 || rangeTo !== null) {
        data = data.slice(rangeFrom, rangeTo === null ? undefined : rangeTo + 1);
      }
      // .limit() narrows the reply before db-max-rows does, as PostgREST does.
      if (limitN !== null) data = data.slice(0, limitN);
      if (server.maxRows !== null && server.maxRows !== undefined) {
        data = data.slice(0, server.maxRows);
      }
      if (wantSingle) return { data: data[0] ?? null, error: null };
      return wantCount ? { data, error: null, count: total } : { data, error: null };
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
    if (f === 'network-resolved') return transportResolved();
    if (f) return { data: null, error: { message: f.message || String(f) } };
    return apply();
  };

  const builder = {
    eq(col, val) { filters.push({ col, val }); return builder; },
    // Strictly greater than: the keyset cursor's operator.
    gt(col, val) { filters.push({ col, val, op: 'gt' }); return builder; },
    // Membership, which is how the pull is scoped to a set of leagues.
    in(col, vals) { filters.push({ col, val: vals, op: 'in' }); return builder; },
    order(col, opts) { orderBy.push({ col, ascending: opts?.ascending !== false }); return builder; },
    select() { wantReturning = true; return builder; },
    // PostgREST's row cap. pingServer uses it for the cheapest possible read;
    // the emulator only has to accept it, because no assertion here depends on
    // the row count coming back.
    // Applied for real now. The keyset pull asks for a page of PAGE_SIZE and
    // relies on an EMPTY reply to know it has finished, so a limit the emulator
    // ignored would make every page the whole table and hide the paging.
    limit(n) { limitN = n; return builder; },
    // A window, inclusive of both ends, as PostgREST's Range header is.
    // `db-max-rows` still applies INSIDE the window, which is exactly what lets
    // a client page by its own page size and stop on a short page.
    range(from, to) { rangeFrom = from; rangeTo = to; return builder; },
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
        select(_cols, opts) { return makeBuilder(server, table, 'select', undefined, opts); },
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
      if (f === 'network-resolved') return transportResolved();
      if (f) return { data: null, error: { message: f.message || String(f) } };
      switch (name) {
        // Which leagues this account runs. The real one reads league_members;
        // the suite sets server.memberships directly.
        case 'my_memberships':
          return {
            data: (server.memberships || []).map(id => ({ league_id: id, role: 'scorekeeper' })),
            error: null,
          };
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
