// The provider suite: StoreProvider, actually executed.
//
// WHY THIS EXISTS
//
// tests/sync.test.js proves the sync PRIMITIVES. Its `Device` class is a
// hand-written copy of StoreProvider's dispatch wrapper and boot ordering, so
// every divergence between that copy and the component - a missing autosave, a
// gate that stops one from running, a step in the wrong order - is invisible to
// it. The reported data loss ("logged stats, closed the app, reopened, 0-0") is
// precisely a boot-ordering and persistence question, so it has to be asked of
// the real component.
//
// So this suite mounts the real StoreProvider on a tiny hook runtime
// (tests/harness/pkg/react-live), against the same PostgREST emulator the sync
// suite uses, with AsyncStorage in memory. It drives it through the reporter's
// sequences and asserts on what reached "disk" and what the board shows after a
// simulated force-quit.
//
// WHAT THIS IS NOT
//
// Not a device, and not React. The runtime is single-threaded, renders one
// component, applies a reducer dispatch eagerly and never re-bases an update. It
// therefore cannot speak to rendering, navigation, gestures, or React's
// scheduling. What it does exercise is real: the provider's own effects, their
// order, its dispatch wrapper, and its storage calls.

const path = require('path');
const M = require(process.env.ITALA_PROVIDER_BUNDLE || path.join(__dirname, '.provider-bundle.js'));
const { FakeServer, makeClient } = require('./harness/fakeSupabase.js');
// The runtime the bundle loaded, not a second copy of it (see react-live).
const React = globalThis.__ITALA_REACT;
const RN = globalThis.__ITALA_RN;

const {
  StoreProvider, __resetSyncPrimitives: resetSyncPrimitives,
  loadState, saveState, loadOutbox, saveOutbox,
  unsyncedCount, SYNC_ENABLED,
} = M;

if (typeof StoreProvider !== 'function') {
  console.error('x provider suite cannot run: StoreProvider is not exported by the bundle');
  process.exit(2);
}
if (!SYNC_ENABLED) {
  console.error('x provider suite cannot run: SYNC_ENABLED is false - set EXPO_PUBLIC_SUPABASE_URL/ANON_KEY');
  process.exit(2);
}

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) pass++;
  else { fail++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(name, a === e, `expected ${e}, got ${a}`);
}

/* --------------------------------------------------------------- the phone -- */

// The auth surface the provider uses, and nothing more: one session read and a
// subscription it unsubscribes on teardown.
function liveClient(server) {
  const c = makeClient(server);
  c.auth = {
    getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  return c;
}

const disk = () => globalThis.__ITALA_DISK;
function wipeDisk() {
  const d = disk();
  for (const k of Object.keys(d)) delete d[k];
}

// One running copy of the app.
class Phone {
  constructor(server) {
    this.server = server;
    globalThis.__ITALA_CLIENT = liveClient(server);
    // Module-level state dies with the process: the ledger, the push chain, the
    // snapshot watermark and the observed connectivity. AsyncStorage does not.
    resetSyncPrimitives();
    this.root = React.render(StoreProvider, { children: null });
  }

  get ctx() { return this.root.element.props.value; }

  // Let every queued microtask, resolved promise and zero-delay timer run, and
  // re-render whenever the provider asked for one. `rounds` is generous: the
  // boot sequence is several awaits deep before it sets `ready`.
  async settle(rounds = 80) {
    for (let i = 0; i < rounds; i++) {
      await new Promise(r => setImmediate(r));
      this.root.flush();
    }
  }

  // A force-quit: no cleanups, no flush, nothing gets a chance to finish. The
  // next Phone on the same server starts from whatever is on disk.
  quit() { this.dead = true; }

  league(id = 'lg1') { return this.ctx.state.leagues.find(l => l.id === id); }
  points(gameId = 'g1') {
    const l = this.league();
    const val = { fg3_make: 3, fg2_make: 2, ft_make: 1 };
    return (l ? l.events : []).filter(e => e.gameId === gameId).reduce((n, e) => n + (val[e.type] || 0), 0);
  }
}

// What the saved AppState on disk says the score is - the only copy that
// survives a force-quit, and the one the reported bug ends up destroying.
function diskPoints(gameId = 'g1') {
  const raw = disk()['hoops.state.v1'];
  if (!raw) return null;
  const st = JSON.parse(raw);
  const l = st.leagues[0];
  if (!l) return null;
  const val = { fg3_make: 3, fg2_make: 2, ft_make: 1 };
  return l.events.filter(e => e.gameId === gameId).reduce((n, e) => n + (val[e.type] || 0), 0);
}

const score = (type, gameId = 'g1') =>
  ({ t: 'ADD_EVENT', leagueId: 'lg1', gameId, teamId: 'tH', playerId: 'p1', type, period: 1 });

// League, two teams, a player each, one live game - dispatched through the real
// provider so every row also goes to the server the way the app sends it.
async function seed(phone) {
  const d = phone.ctx.dispatch;
  d({ t: 'ADD_LEAGUE', id: 'lg1', name: 'BPBL', season: 'S3' });
  d({ t: 'ADD_TEAM', leagueId: 'lg1', name: 'Warriors', id: 'tH' });
  d({ t: 'ADD_TEAM', leagueId: 'lg1', name: 'Bulls', id: 'tA' });
  d({ t: 'ADD_PLAYER', leagueId: 'lg1', teamId: 'tH', name: 'Juan A', number: '17', id: 'p1' });
  d({ t: 'ADD_PLAYER', leagueId: 'lg1', teamId: 'tA', name: 'Juan C', number: '7', id: 'p2' });
  d({ t: 'CREATE_GAME', id: 'g1', leagueId: 'lg1', homeTeamId: 'tH', awayTeamId: 'tA' });
  d({ t: 'SET_GAME_STATUS', leagueId: 'lg1', gameId: 'g1', status: 'live' });
  await phone.settle();
}

/* ==========================================================================
   GROUP P - the reported loss, through the real provider
   ========================================================================== */

// CASE 1, as reported: connected the whole time. Log stats, leave the game,
// force-quit, reopen. The stats must still be there.
async function p1_online_stats_survive_a_force_quit() {
  wipeDisk();
  const server = new FakeServer();
  const A = new Phone(server);
  await A.settle();
  await seed(A);

  A.ctx.dispatch(score('fg3_make'));
  A.ctx.dispatch(score('fg3_make'));
  A.ctx.dispatch(score('fg3_make'));
  await A.settle();

  eq('P1.1 the board shows all three baskets', A.points(), 9);
  eq('P1.2 all three reached the server', server.count('events'), 3);
  eq('P1.3 the saved state on disk holds them', diskPoints(), 9);
  eq('P1.4 nothing is waiting to be sent', unsyncedCount(), 0);

  A.quit();
  const B = new Phone(server);
  await B.settle();
  eq('P1.5 reopening shows the same score', B.points(), 9);
  eq('P1.6 and disk still holds it', diskPoints(), 9);
}

// CASE 2, as reported: connected, log a stat; disconnect, log more; reconnect
// and watch it say Syncing then Synced; force-quit; reopen. Driven through the
// provider's OWN reconnect wiring - the foreground handler pings, the net effect
// drains - rather than by calling the drain directly.
async function p2_offline_round_trip_survives_a_force_quit() {
  wipeDisk();
  const server = new FakeServer();
  const A = new Phone(server);
  await A.settle();
  await seed(A);

  A.ctx.dispatch(score('fg2_make'));
  await A.settle();
  eq('P2.1 the online basket is on the server', server.count('events'), 1);

  // The connection goes. The installed client RESOLVES a transport failure with
  // status 0 rather than throwing, which is the emulator's default mode.
  server.offline(true);
  A.ctx.dispatch(score('fg3_make'));
  A.ctx.dispatch(score('fg3_make'));
  await A.settle();

  eq('P2.2 the board shows all three', A.points(), 8);
  eq('P2.3 the two offline ones did not reach the server', server.count('events'), 1);
  eq('P2.4 the provider knows it is offline', A.ctx.net, 'offline');
  eq('P2.5 two writes are queued', A.ctx.pendingWrites, 2);
  eq('P2.6 the banner says so', A.ctx.sync.phase, 'offline-pending');
  ok('P2.7 the queue is on disk', !!disk()['hoops.outbox.v1'], JSON.stringify(Object.keys(disk())));

  // Reconnect. The app notices the way it does on a real device: it comes back
  // to the foreground, pings, and the reachable effect drains the queue.
  server.offline(false);
  RN.__emitAppState('active');
  await A.settle();

  eq('P2.8 the drain sent both', server.count('events'), 3);
  eq('P2.9 nothing is waiting', A.ctx.pendingWrites, 0);
  ok('P2.10 and it reports nothing outstanding',
     A.ctx.sync.pending === 0 && A.ctx.sync.tone === 'ok', `${A.ctx.sync.phase} / ${A.ctx.sync.label}`);
  eq('P2.11 disk holds the full score', diskPoints(), 8);

  A.quit();
  const B = new Phone(server);
  await B.settle();
  eq('P2.12 reopening shows the full score', B.points(), 8);
  eq('P2.13 and disk still holds it', diskPoints(), 8);
}

// CASE 1 AGAIN, on an account that already has history - which is the only
// thing this needs to be a real device rather than a fresh install.
//
// Nothing here is offline, nothing fails, and nothing is refused. Every basket
// is inserted, acknowledged, confirmed and retired. The only difference from P1
// is that the events table holds more rows than the server will return in one
// response, and `fetchAllState` asks for them in one response.
//
// PostgREST caps a reply at `db-max-rows` (1000 on a default Supabase project)
// and says nothing about having done so. The events read is ordered ascending,
// so the rows it drops are the NEWEST ones: the game being scored right now.
// The reply is a success, so the snapshot is applied; the ledger is empty,
// because the server genuinely did confirm every write; and HYDRATE therefore
// deletes the newest game's events as though another device had removed them.
// The autosave then writes that over the only durable copy.
async function p3_a_truncated_read_must_not_delete_the_game() {
  wipeDisk();
  const server = new FakeServer();
  const A = new Phone(server);
  await A.settle();
  await seed(A);

  // Earlier history, in an earlier game: four baskets already on the server.
  // `id` and `ts` are given explicitly (stampActionIds passes such an action
  // straight through) so "older" and "newer" are unambiguous and the row the
  // cap drops is decided by the test rather than by the clock.
  A.ctx.dispatch({ t: 'CREATE_GAME', id: 'g0', leagueId: 'lg1', homeTeamId: 'tH', awayTeamId: 'tA' });
  for (let i = 0; i < 4; i++) {
    A.ctx.dispatch({ ...score('fg2_make', 'g0'), id: `old${i}`, ts: 1000 + i });
  }
  await A.settle();
  eq('P3.1 the history is on the server', server.count('events'), 4);

  // Tonight's game, scored online with a live connection throughout.
  for (let i = 0; i < 3; i++) {
    A.ctx.dispatch({ ...score('fg3_make'), id: `new${i}`, ts: 5000 + i });
  }
  await A.settle();

  eq('P3.2 the board shows tonight 9', A.points('g1'), 9);
  eq('P3.3 every basket reached the server', server.count('events'), 7);
  eq('P3.4 nothing failed and nothing is queued', A.ctx.pendingWrites, 0);
  eq('P3.5 the last write reported success', A.ctx.syncState === 'error' ? 'error' : 'ok', 'ok');
  eq('P3.6 disk holds tonight 9', diskPoints('g1'), 9);

  // The server will not return more than four event rows in one reply, and it
  // does not say so. Everything else about it is healthy.
  server.maxRows = 4;

  A.quit();
  const B = new Phone(server);
  await B.settle();

  eq('P3.7 the earlier game is unaffected', B.points('g0'), 8);
  eq('P3.8 tonight is still on the board after reopening', B.points('g1'), 9);
  eq('P3.9 and the durable copy was not overwritten with the truncated read', diskPoints('g1'), 9);

  // Not a lucky refusal: the pull has to have actually happened and actually
  // hydrated, or P3.8 would pass for the wrong reason.
  eq('P3.10 the pull was applied, not skipped', B.ctx.initialSyncDone, true);
  eq('P3.11 and the league came from the server, not a stale local copy',
     (B.league() || {}).name, 'BPBL');
}

// The server ANSWERS and refuses the row - RLS, a closed league, a membership
// that lapsed mid-game. Not an outage: the response carries an error and NO
// status, so nothing in the transport classifier can mistake it for one.
//
// This is the path `check` used to swallow. The push RESOLVED, the provider
// called confirmPending, and `outboxSnapshot`/`drainableEntries` both filter on
// an unconfirmed entry - so the write never reached disk, was never retried, and
// the next snapshot retired it on ordering alone and handed back the server's
// stale row. Measured on this harness before the fix: unsyncedCount() 0, an
// empty outbox key, phase 'saved', and the lineup reverted by the next pull.
async function p4_a_refused_write_is_not_reported_saved() {
  wipeDisk();
  const server = new FakeServer();
  const A = new Phone(server);
  await A.settle();
  await seed(A);
  eq('P4.1 nothing is waiting after a clean seed', A.ctx.pendingWrites, 0);

  server.failures['upsert:games'] =
    { message: 'new row violates row-level security policy for table "games"' };
  A.ctx.dispatch({ t: 'SET_LINEUP', leagueId: 'lg1', gameId: 'g1', side: 'home', playerIds: ['p1'] });
  await A.settle();

  const g = () => (A.league() || { games: [] }).games.find(x => x.id === 'g1') || {};
  eq('P4.2 the five is on the board', g().homeOnCourt, ['p1']);
  eq('P4.3 and the server does not have it', server.find('games', 'g1').home_on_court, []);
  eq('P4.4 so the write is QUEUED, not confirmed', A.ctx.pendingWrites, 1);
  eq('P4.5 the provider recorded a failed write', A.ctx.syncState, 'error');
  eq('P4.6 a refusal is not an outage, so the device stays online', A.ctx.net, 'online');
  eq('P4.7 the chip is the failed state', A.ctx.sync.phase, 'failed');
  eq('P4.8 in the bad tone', A.ctx.sync.tone, 'bad');
  ok('P4.9 and it does not claim everything is saved',
     !/Everything on this device is saved/.test(A.ctx.sync.detail), A.ctx.sync.detail);
  ok('P4.10 the queue reached disk, where a relaunch can find it',
     /"gameId":"g1"/.test(String(disk()['hoops.outbox.v1'])), String(disk()['hoops.outbox.v1']));

  // A pull while it is pinned must not hand the stale five back.
  await A.ctx.refresh();
  await A.settle();
  eq('P4.11 a refresh does not revert the five', g().homeOnCourt, ['p1']);
  ok('P4.12 nor does the autosave destroy the durable copy',
     /"homeOnCourt":\["p1"\]/.test(String(disk()['hoops.state.v1'])));

  // The rights come back. The provider's own reconnect wiring drains it, which
  // is what makes a red chip a state the app can leave rather than a dead end.
  // Pull-to-refresh rather than the foreground handler, and the reason is a
  // limitation of THIS harness rather than of the app. A Phone is never
  // unmounted (a force-quit has no cleanups), so by this point eight
  // StoreProviders are mounted at once over ONE module-level ledger - which on a
  // real device is impossible. `__emitAppState` reaches every one of them, and
  // the preflight provider, whose state holds a league with no games at all,
  // then runs `pruneOutbox` and drops this queued GAME entry as a write for a
  // deleted game. `refresh()` goes through the same drain but only through the
  // phone under test. The foreground and reconnect wiring itself is covered by
  // P2 and P5.
  delete server.failures['upsert:games'];
  await A.ctx.refresh();
  await A.settle();
  eq('P4.13 the queued row is replayed', server.find('games', 'g1').home_on_court, ['p1']);
  eq('P4.14 nothing is left waiting', A.ctx.pendingWrites, 0);
  ok('P4.15 and the chip has cleared', A.ctx.sync.tone === 'ok', `${A.ctx.sync.phase} / ${A.ctx.sync.label}`);
}

// A game created with no connection. CREATE_GAME names its row `id`, not
// `gameId`, so `recordPending` minted no token for it: no ledger entry, no
// outbox row, and a push through the non-critical `check`. Nothing anywhere held
// it open, so the next pull deleted it and the autosave made that permanent.
async function p5_a_game_created_offline_survives_a_force_quit() {
  wipeDisk();
  const server = new FakeServer();
  const A = new Phone(server);
  await A.settle();
  await seed(A);

  server.offline(true);
  A.ctx.dispatch({ t: 'CREATE_GAME', id: 'g9', leagueId: 'lg1', homeTeamId: 'tH', awayTeamId: 'tA' });
  await A.settle();

  ok('P5.1 the game is in the list', !!(A.league() || { games: [] }).games.find(x => x.id === 'g9'));
  eq('P5.2 the server never got it', server.has('games', 'g9'), false);
  eq('P5.3 the provider knows it is offline', A.ctx.net, 'offline');
  eq('P5.4 and the create is QUEUED rather than reported saved', A.ctx.pendingWrites, 1);
  eq('P5.5 the banner says so', A.ctx.sync.phase, 'offline-pending');
  ok('P5.6 the queue is on disk', /"gameId":"g9"/.test(String(disk()['hoops.outbox.v1'])),
     String(disk()['hoops.outbox.v1']));

  // Force-quit mid-outage, reopen with the connection back. The boot pull used
  // to hydrate a snapshot that had never heard of the game, delete it, and
  // autosave the deletion.
  A.quit();
  server.offline(false);
  const B = new Phone(server);
  await B.settle();
  // The boot pull flips the connection back to online and the reconnect effect
  // drains from there. The explicit refresh is belt and braces: see P4 for why
  // a suite that keeps every Phone mounted cannot rely on a broadcast handler
  // to be the one that drains.
  await B.ctx.refresh();
  await B.settle();

  ok('P5.7 reopening still has the game', !!(B.league() || { games: [] }).games.find(x => x.id === 'g9'));
  ok('P5.8 and the durable copy agrees', /"id":"g9"/.test(String(disk()['hoops.state.v1'])));
  ok('P5.9 the queued create reached the server', server.has('games', 'g9'));
  eq('P5.10 nothing is left waiting', B.ctx.pendingWrites, 0);
}

/* --------------------------------------------------------------- preflight --
 * A harness whose storage or whose server wiring silently does nothing can
 * report any result it likes, in either direction. Both were briefly true here:
 * stubs/asyncstorage-live.js exported `{ default: ... }` with no `__esModule`
 * marker, so esbuild's interop set `.default` to the whole module and every
 * `AsyncStorage.setItem` was a TypeError swallowed by `saveState`'s best-effort
 * catch. The suite reported a reproduction of the reported data loss that was
 * really just its own dead storage.
 *
 * So the plumbing is proved before a single app assertion runs, and a failure
 * here ABORTS rather than counting as a failed test - a broken harness is not
 * evidence about the app.
 */
async function preflight() {
  const die = (why) => {
    console.error(`x provider suite cannot run: ${why}`);
    process.exit(2);
  };

  // 1. AsyncStorage actually stores.
  wipeDisk();
  await saveState({ leagues: [{ id: 'lgX', name: 'n', season: 's', teams: [], players: [], games: [], events: [] }] });
  const back = await loadState();
  if (!back || !back.leagues || back.leagues.length !== 1 || back.leagues[0].id !== 'lgX') {
    die(`saveState/loadState do not round trip (got ${JSON.stringify(back)}) - the AsyncStorage stub is not wired up`);
  }
  if (!disk()['hoops.state.v1']) die('saveState wrote nothing to the in-memory disk');

  // 2. The outbox key too: it is a separate key and a separate code path.
  await saveOutbox([{ token: 'add:e1', kind: 'event', leagueId: 'lgX', op: 'add', eventId: 'e1', event: { id: 'e1', gameId: 'g', teamId: 't', playerId: null, type: 'fg2_make', period: 1, ts: 1 }, attempts: 0, lastError: null }]);
  const ob = await loadOutbox();
  if (!Array.isArray(ob) || ob.length !== 1 || ob[0].token !== 'add:e1') {
    die(`saveOutbox/loadOutbox do not round trip (got ${JSON.stringify(ob)})`);
  }

  // 3. The provider really talks to the fake server: seed a league ON THE
  //    SERVER ONLY, boot, and see it arrive. That exercises createClient ->
  //    supabase-live handle -> fetchAllState -> applySnapshot in one go, so a
  //    dead client cannot masquerade as an app that read nothing.
  wipeDisk();
  const server = new FakeServer();
  server.rows.leagues.push({
    id: 'lgP', name: 'Preflight', season: 'S1', kind: 'league', foul_out_limit: 5,
    track_misses: true, track_turnovers: true, is_shared: null, is_closed: null,
    is_archived: null, created_at: 1,
  });
  const P = new Phone(server);
  await P.settle();
  if (!P.league('lgP')) die('the provider did not read the league seeded on the fake server - the supabase stub is not wired up');
  if (!disk()['hoops.state.v1']) die('the provider never wrote its state to disk after a successful boot pull');

  // 4. The react-native handle is the one the provider subscribed through.
  //    Without this the reconnect assertions below would exercise nothing: the
  //    bundle inlines rn-live, so a second copy required from disk has its own
  //    empty listener set and `__emitAppState` would be a no-op that looks like
  //    an app which simply did not drain.
  if (typeof RN !== 'object' || typeof RN.__emitAppState !== 'function') {
    die('the react-native stub was not published on globalThis.__ITALA_RN');
  }
  if (RN.__appStateListenerCount() === 0) {
    die('the provider registered no AppState listener - the react-native stub is not the instance it subscribed through');
  }
  wipeDisk();
}

/* ------------------------------------------------------------------ runner -- */

const groups = [
  ['P1 online stats survive a force-quit', p1_online_stats_survive_a_force_quit],
  ['P2 offline round trip survives a force-quit', p2_offline_round_trip_survives_a_force_quit],
  ['P3 a truncated read must not delete the game', p3_a_truncated_read_must_not_delete_the_game],
  ['P4 a refused write is not reported saved', p4_a_refused_write_is_not_reported_saved],
  ['P5 a game created offline survives a force-quit', p5_a_game_created_offline_survives_a_force_quit],
];

(async () => {
  await preflight();
  for (const [label, fn] of groups) {
    try { await fn(); }
    catch (e) { fail++; failures.push(`${label} THREW :: ${(e && e.stack) || e}`); }
  }
  console.log(`\n  provider: ${pass} passed, ${fail} failed`);
  for (const f of failures) console.log(`    x ${f}`);
  process.exit(fail ? 1 : 0);
})();
