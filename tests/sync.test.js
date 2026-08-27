// Two-device sync tests.
//
// The reducer suite proves the LOCAL effect of an action. This suite proves the
// SERVER effect, which is where undo went wrong: a stat can disappear from the
// device that undid it while surviving on the server, and the next pull - which
// fires automatically on any realtime change - hands it straight back. On one
// device that is invisible. On two it is live scoreboard corruption.
//
// Each test drives the real reducer and the real sync layer (pushAction /
// fetchAllState) against a PostgREST emulator (tests/harness/fakeSupabase.js)
// that models per-operation latency and RLS-as-a-silent-filter.
//
// The dispatch-side sync primitives (undo target resolution, the serialized
// push queue, the undo tombstone guard) are imported from the app, not
// reimplemented here - see tests/static.test.js for the check that
// StoreProvider actually wires them up.

const M = require(process.env.ITALA_BUNDLE || '../.test-bundle.js');
const { FakeServer, makeClient } = require('./harness/fakeSupabase.js');

const {
  reducer, pushAction, fetchAllState,
  // The dispatch-side sync primitives. Imported, not reimplemented: if one of
  // these is removed the suite fails to load rather than quietly testing a copy
  // of behaviour the app no longer has.
  resolveUndoTarget, enqueuePush, guardUndoneEvent, releaseUndoGuard,
  __resetSyncPrimitives: resetSyncPrimitives,
} = M;

for (const [name, fn] of Object.entries({
  reducer, pushAction, fetchAllState, resolveUndoTarget, enqueuePush,
  guardUndoneEvent, releaseUndoGuard, resetSyncPrimitives,
})) {
  if (typeof fn !== 'function') {
    console.error(`✗ sync suite cannot run: '${name}' is not exported by the app bundle`);
    process.exit(2);
  }
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

/* ------------------------------------------------------------------ device -- */

// A faithful stand-in for one running copy of the app: the real reducer for
// local state, the real sync layer for the server, and the same wrapped-dispatch
// glue StoreProvider uses.
class Device {
  constructor(name, server) {
    this.name = name;
    this.server = server;
    this.client = makeClient(server);
    this.state = { leagues: [], settings: { trackMisses: true } };
    this.inflight = [];
    this.syncState = 'idle';
    this.pushErrors = [];
  }

  dispatch(incoming) {
    if (incoming.t === 'HYDRATE') { this.state = reducer(this.state, incoming); return; }

    const action = resolveUndoTarget(this.state, incoming);
    // Capture the post-dispatch state, exactly as StoreProvider does. pushAction
    // reads "the row this action produced" out of it, so it must be the snapshot
    // from THIS dispatch and not whatever the device holds when the queued push
    // eventually runs.
    const next = reducer(this.state, action);
    this.state = next;

    // Tombstone the undone row so a refetch already in flight when the undo
    // happened cannot hand it back.
    if (action.t === 'UNDO_EVENT' && action.eventId) guardUndoneEvent(action.eventId);
    if (action.t === 'REDO_EVENT') {
      const lg = next.leagues.find(l => l.id === action.leagueId);
      const ev = lg && lg.events[lg.events.length - 1];
      if (ev) releaseUndoGuard(ev.id);
    }

    this.syncState = 'saving';
    const p = enqueuePush(() => pushAction(this.client, action, next)).then(
      () => { this.syncState = 'saved'; },
      e => { this.syncState = 'error'; this.pushErrors.push(String(e && e.message ? e.message : e)); },
    );
    this.inflight.push(p);
  }

  // Wait for every push this device has issued to reach the server.
  async settle() {
    while (this.inflight.length) {
      const batch = this.inflight;
      this.inflight = [];
      await Promise.all(batch);
    }
  }

  // A realtime refetch: pull the whole server snapshot and hydrate.
  async pull() {
    const remote = await fetchAllState(this.client);
    if (remote && remote.leagues) this.applySnapshot(remote);
  }

  // Split out so a test can capture a snapshot at one moment and apply it later,
  // which is what a slow refetch that overlaps an undo actually does.
  async snapshot() { return fetchAllState(this.client); }
  applySnapshot(remote) {
    this.dispatch({ t: 'HYDRATE', state: { leagues: remote.leagues, settings: remote.settings || this.state.settings } });
  }

  league(id = 'lg1') { return this.state.leagues.find(l => l.id === id); }
  eventIds(gameId = 'g1') {
    const l = this.league();
    return (l ? l.events : []).filter(e => e.gameId === gameId).map(e => e.id);
  }
  points(gameId = 'g1') {
    const l = this.league();
    const val = { '3pm': 3, '2pm': 2, ftm: 1 };
    return (l ? l.events : [])
      .filter(e => e.gameId === gameId)
      .reduce((n, e) => n + (val[e.type] || 0), 0);
  }
}

// League + two teams + a player each + a scheduled game, mirrored to the server.
async function seed(server) {
  const A = new Device('A', server);
  A.dispatch({ t: 'ADD_LEAGUE', id: 'lg1', name: 'BPBL', season: 'S3' });
  A.dispatch({ t: 'ADD_TEAM', leagueId: 'lg1', name: 'Warriors', id: 'tH' });
  A.dispatch({ t: 'ADD_TEAM', leagueId: 'lg1', name: 'Bulls', id: 'tA' });
  A.dispatch({ t: 'ADD_PLAYER', leagueId: 'lg1', teamId: 'tH', name: 'Juan A', number: '17', id: 'p1' });
  A.dispatch({ t: 'ADD_PLAYER', leagueId: 'lg1', teamId: 'tA', name: 'Juan C', number: '7', id: 'p2' });
  A.dispatch({ t: 'CREATE_GAME', id: 'g1', leagueId: 'lg1', homeTeamId: 'tH', awayTeamId: 'tA' });
  A.dispatch({ t: 'SET_GAME_STATUS', leagueId: 'lg1', gameId: 'g1', status: 'live' });
  await A.settle();
  return A;
}

const score = (leagueId, gameId, teamId, playerId, type, period) =>
  ({ t: 'ADD_EVENT', leagueId, gameId, teamId, playerId, type, period });

/* ==========================================================================
   GROUP S1 - the bug: an undone event that survives on the server comes back
   ========================================================================== */

async function s1_resurrection_is_real() {
  const server = new FakeServer();
  const A = await seed(server);

  A.dispatch(score('lg1', 'g1', 'tH', 'p1', '3pm', 1));
  await A.settle();
  const evId = A.eventIds()[0];
  eq('S1.1 event mirrored to server', server.count('events'), 1);
  eq('S1.2 device A shows 3 points', A.points(), 3);

  // Simulate the pre-fix sync layer: undo locally, do NOT touch the server.
  // This is the "the next pull will reconcile it" claim, tested.
  const undone = resolveUndoTarget(A.state, { t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  eq('S1.3 undo resolves the right event id', undone.eventId, evId);
  A.state = reducer(A.state, undone);
  eq('S1.4 undo clears the points locally', A.points(), 0);

  // The next pull does not reconcile it - it resurrects it.
  await A.pull();
  eq('S1.5 an undo that skips the server is undone by the next pull', A.points(), 3);
  ok('S1.6 the resurrected row is the same event', A.eventIds().includes(evId));

  // And a second device, which never saw the undo at all, is simply wrong.
  const B = new Device('B', server);
  await B.pull();
  eq('S1.7 device B still shows the undone basket', B.points(), 3);
}

async function s2_head_deletes_the_row() {
  const server = new FakeServer();
  const A = await seed(server);
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', '3pm', 1));
  await A.settle();
  const evId = A.eventIds()[0];

  A.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  await A.settle();

  ok('S2.1 undo deletes the row server-side', !server.has('events', evId));
  const del = server.log.filter(x => x.op === 'delete' && x.table === 'events');
  eq('S2.2 exactly one delete issued', del.length, 1);
  eq('S2.3 delete targets the undone id', del[0].filters, [{ col: 'id', val: evId }]);

  await A.pull();
  eq('S2.4 pull does not resurrect it', A.points(), 0);

  const B = new Device('B', server);
  await B.pull();
  eq('S2.5 device B agrees', B.points(), 0);
}

async function s3_redo_round_trips() {
  const server = new FakeServer();
  const A = await seed(server);
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', '2pm', 1));
  await A.settle();
  A.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  await A.settle();
  A.dispatch({ t: 'REDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  await A.settle();

  eq('S3.1 redo restores the row server-side', server.count('events'), 1);
  await A.pull();
  eq('S3.2 redo survives a pull', A.points(), 2);
  const B = new Device('B', server);
  await B.pull();
  eq('S3.3 device B sees the redone basket', B.points(), 2);
}

/* ==========================================================================
   GROUP S4 - undoing a mis-tap immediately: the delete can overtake the insert
   ==========================================================================
   Tapping a stat and undoing it straight away is the most common use of undo on
   a live scoreboard. Both pushes are fired without waiting for the previous one,
   so on a connection where the second request is served first the DELETE runs
   against a row that does not exist yet and removes nothing; the INSERT then
   lands. Local state says the basket is gone, the server says it is there, and
   the next pull believes the server.
*/

async function s4_undo_racing_the_insert() {
  const server = new FakeServer();
  const A = await seed(server);

  // The insert is slow, the delete is quick - request reordering, not exotic.
  server.latency['insert:events'] = 60;
  server.latency['delete:events'] = 0;

  A.dispatch(score('lg1', 'g1', 'tH', 'p1', '3pm', 1));
  const evId = A.eventIds()[0];
  A.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' }); // user taps undo at once
  await A.settle();

  eq('S4.1 undo cleared it locally', A.points(), 0);
  ok('S4.2 undone row must not survive on the server', !server.has('events', evId),
     `server still holds ${evId}`);

  await A.pull();
  eq('S4.3 the undone basket does not come back on pull', A.points(), 0);

  const B = new Device('B', server);
  await B.pull();
  eq('S4.4 device B does not see a phantom basket', B.points(), 0);
}

/* ==========================================================================
   GROUP S5 - a refetch already in flight when the undo happens
   ==========================================================================
   Realtime fires on the INSERT, so a refetch is very often already running when
   the user taps undo a moment later. That snapshot was taken while the row still
   existed; applying it after the undo puts the basket back even though the
   server delete succeeded.
*/

async function s5_inflight_refetch() {
  const server = new FakeServer();
  const A = await seed(server);
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', 'ftm', 1));
  await A.settle();
  const evId = A.eventIds()[0];

  // Realtime echo for the insert kicks off a refetch...
  const pending = await A.snapshot();
  // ...the user taps undo while it is on the wire...
  A.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  await A.settle();
  ok('S5.1 server row deleted', !server.has('events', evId));
  // ...and the stale snapshot arrives.
  A.applySnapshot(pending);

  eq('S5.2 a stale in-flight snapshot must not resurrect the undone event', A.points(), 0);
}

/* ==========================================================================
   GROUP S6 - a delete that row-level security silently drops
   ==========================================================================
   PostgREST does not report an error when RLS hides the rows a DELETE targeted:
   it succeeds having removed nothing. So a scorekeeper whose rights lapsed mid
   game (league closed, membership revoked) gets a clean-looking undo, no error
   badge, and the stat back on the next pull. The client has to ask for the
   deleted rows to tell the two apart.
*/

async function s6_rls_silent_delete() {
  const server = new FakeServer();
  const A = await seed(server);
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', '3pm', 1));
  await A.settle();
  const evId = A.eventIds()[0];

  // Rights lapse: deletes on events are now silently filtered out.
  server.rls.events = (_row, op) => op !== 'delete';

  A.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  await A.settle();

  ok('S6.1 a delete that removed nothing must not report success',
     A.syncState === 'error',
     `syncState was '${A.syncState}' with errors ${JSON.stringify(A.pushErrors)}`);

  // Even so, the local view must not silently disagree with the server.
  await A.pull();
  eq('S6.2 the undo is not quietly reverted by the next pull', A.points(), 0);
}

/* ==========================================================================
   GROUP S7 - ordinary two-device convergence (guard against over-fixing)
   ========================================================================== */

async function s7_two_device_convergence() {
  const server = new FakeServer();
  const A = await seed(server);
  const B = new Device('B', server);
  await B.pull();

  A.dispatch(score('lg1', 'g1', 'tH', 'p1', '3pm', 1));
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', '2pm', 1));
  await A.settle();
  B.dispatch(score('lg1', 'g1', 'tA', 'p2', 'ftm', 1));
  await B.settle();

  await A.pull(); await B.pull();
  eq('S7.1 A and B agree on the score', [A.points(), B.points()], [6, 6]);
  eq('S7.2 three events on the server', server.count('events'), 3);

  // B undoes its own free throw; A must see it go.
  const ftId = (B.league().events.filter(e => e.type === 'ftm')[0] || {}).id;
  B.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1', eventId: ftId });
  await B.settle();
  await A.pull();
  eq('S7.3 A sees B\'s undo', A.points(), 5);
  eq('S7.4 server has two events left', server.count('events'), 2);

  // A tombstone must not outlive its purpose: a fresh identical stat still syncs.
  A.dispatch(score('lg1', 'g1', 'tA', 'p2', 'ftm', 2));
  await A.settle();
  await B.pull();
  eq('S7.5 a new free throw after an undo still reaches B', B.points(), 6);
}

async function s8_undo_of_a_foul_restores_the_court() {
  // Undo has a second server effect: a foul-out benches a player, so undoing
  // the foul that caused it has to push the game row back too.
  const server = new FakeServer();
  const A = await seed(server);
  A.dispatch({ t: 'SET_LINEUPS', leagueId: 'lg1', gameId: 'g1', home: ['p1'], away: ['p2'] });
  await A.settle();
  for (let i = 0; i < 5; i++) {
    A.dispatch({ t: 'ADD_EVENT', leagueId: 'lg1', gameId: 'g1', teamId: 'tH', playerId: 'p1', type: 'pf', period: 1 });
  }
  await A.settle();
  const g = server.find('games', 'g1');
  eq('S8.1 fouled-out player benched on the server', g.home_on_court, []);

  A.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  await A.settle();
  eq('S8.2 undo drops the fifth foul locally',
     A.league().events.filter(e => e.type === 'pf').length, 4);
  const g2 = server.find('games', 'g1');
  eq('S8.3 undoing the foul-out puts the player back on the server court', g2.home_on_court, ['p1']);
  await A.pull();
  eq('S8.4 the player is on court after a pull', A.league().games[0].homeOnCourt, ['p1']);
}

/* --------------------------------------------------------------------------- */

const TESTS = [
  ['S1 resurrection is real', s1_resurrection_is_real],
  ['S2 undo deletes server-side', s2_head_deletes_the_row],
  ['S3 redo round-trips', s3_redo_round_trips],
  ['S4 undo racing the insert', s4_undo_racing_the_insert],
  ['S5 in-flight refetch', s5_inflight_refetch],
  ['S6 silently filtered delete', s6_rls_silent_delete],
  ['S7 two-device convergence', s7_two_device_convergence],
  ['S8 undoing a foul-out', s8_undo_of_a_foul_restores_the_court],
];

(async () => {
  for (const [label, fn] of TESTS) {
    resetSyncPrimitives();
    try {
      await fn();
    } catch (e) {
      fail++;
      failures.push(`${label} THREW :: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
    }
  }

  const line = '='.repeat(64);
  console.log(line);
  console.log(`SYNC SUITE:  ${pass} passed,  ${fail} failed`);
  if (fail) {
    console.log('-'.repeat(64));
    for (const f of failures) console.log('  ✗ ' + f);
  }
  console.log(line);
  process.exit(fail ? 1 : 0);
})();
