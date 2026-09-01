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
  stampActionIds, enqueuePush,
  beginSnapshot, recordPending, confirmPending, failPending, pendingCount,
  __resetSyncPrimitives: resetSyncPrimitives,
} = M;

for (const [name, fn] of Object.entries({
  reducer, pushAction, fetchAllState, stampActionIds, enqueuePush,
  beginSnapshot, recordPending, confirmPending, failPending, pendingCount,
  resetSyncPrimitives,
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

    const action = stampActionIds(this.state, incoming);
    // Capture the post-dispatch state, exactly as StoreProvider does. pushAction
    // reads "the row this action produced" out of it, so it must be the snapshot
    // from THIS dispatch and not whatever the device holds when the queued push
    // eventually runs.
    const next = reducer(this.state, action);
    this.state = next;

    // Record the write in the pending ledger before the push starts, so a
    // snapshot landing mid-flight is reconciled against it rather than
    // overwriting it. Same call the app makes.
    const touched = recordPending(action, next);

    this.syncState = 'saving';
    const p = enqueuePush(() => pushAction(this.client, action, next)).then(
      () => { confirmPending(touched); this.syncState = 'saved'; },
      e => {
        failPending(touched);
        this.syncState = 'error';
        this.pushErrors.push(String(e && e.message ? e.message : e));
        // All-or-nothing bundles roll their local half back, exactly as
        // StoreProvider does. tests/static.test.js checks the app still does it.
        if (action.t === 'REC_SETUP_GAME' || action.t === 'BULK_IMPORT_ROSTER') {
          const isGame = action.t === 'REC_SETUP_GAME';
          this.state = reducer(this.state, {
            t: 'ROLLBACK_BUNDLE',
            leagueId: action.leagueId,
            gameIds: isGame ? [action.gameId] : [],
            teamIds: action.teams.map(t => t.id),
            playerIds: action.teams.flatMap(t => t.players.map(pl => pl.id)),
            removeLeague: isGame && !!action.ensureLeague,
          });
        }
      },
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
    const snap = await this.snapshot();
    if (snap && snap.remote && snap.remote.leagues) this.applySnapshot(snap);
  }

  // Split out so a test can capture a snapshot at one moment and apply it later,
  // which is what a slow refetch that overlaps an undo actually does. The tick
  // is taken BEFORE the read, exactly as StoreProvider does it: that is what
  // makes "this snapshot predates that confirmation" decidable.
  async snapshot() {
    const at = beginSnapshot();
    const remote = await fetchAllState(this.client);
    return { at, remote };
  }
  applySnapshot(snap) {
    this.dispatch({ t: 'HYDRATE', state: { leagues: snap.remote.leagues }, snapshotAt: snap.at });
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
  const undone = stampActionIds(A.state, { t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
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

/* ==========================================================================
   GROUP S9 - the reported scoreboard bug: a pending INSERT clobbered by a
   snapshot that predates it, then double-counted when it lands
   ==========================================================================
   Reported as: "I tapped the 3PT stat, it updated +3 but reverted after a
   delay. Then I added another +3 and it added +6."

   The old undo tombstone protected an event that had been REMOVED locally.
   Nothing protected one that had been ADDED locally, which is the scoreboard
   itself. Every realtime echo starts a full refetch, so a snapshot read before
   a tap's INSERT lands routinely arrives after it - and HYDRATE replaced the
   whole event list with it.
*/

async function s9_pending_insert_survives_a_stale_snapshot() {
  const server = new FakeServer();
  const A = await seed(server);

  // The insert is slow. The refetch that a previous echo triggered is not.
  server.latency['insert:events'] = 60;

  A.dispatch(score('lg1', 'g1', 'tH', 'p1', '3pm', 1));
  eq('S9.1 the tap shows immediately', A.points(), 3);

  // A refetch reads the server BEFORE the insert lands: zero events.
  const stale = await A.snapshot();
  eq('S9.2 the snapshot genuinely predates the insert', server.count('events'), 0);

  // ...and arrives after it. This is the moment the basket used to vanish.
  A.applySnapshot(stale);
  eq('S9.3 a snapshot older than the tap must not revert it', A.points(), 3);

  // The scorekeeper adds a second basket. Under the bug they were "fixing" a
  // board that had dropped back to zero; the total must now be six, not three.
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', '3pm', 1));
  eq('S9.4 two baskets is six points, once', A.points(), 6);

  await A.settle();
  eq('S9.5 both rows reached the server', server.count('events'), 2);

  await A.pull();
  eq('S9.6 a pull after both inserts agrees', A.points(), 6);
  eq('S9.7 no phantom third row', server.count('events'), 2);

  const B = new Device('B', server);
  await B.pull();
  eq('S9.8 the other device agrees', B.points(), 6);
}

/* The reported sequence end to end: undo, tap, stale snapshot, tap again. */
async function s10_undo_then_tap_then_stale_snapshot() {
  const server = new FakeServer();
  const A = await seed(server);

  A.dispatch(score('lg1', 'g1', 'tH', 'p1', '3pm', 1));
  await A.settle();
  await A.pull();
  eq('S10.1 starting point: one basket, synced', A.points(), 3);

  server.latency['insert:events'] = 80;

  A.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  await A.settle();
  eq('S10.2 undo clears the board', A.points(), 0);
  eq('S10.3 and clears the server', server.count('events'), 0);

  // Echo from the delete starts a refetch: reads zero events.
  const stale = await A.snapshot();

  // The scorekeeper taps 3PT while that refetch is on the wire.
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', '3pm', 1));
  eq('S10.4 the new basket shows', A.points(), 3);

  A.applySnapshot(stale);
  eq('S10.5 the stale snapshot must not take it away again', A.points(), 3);

  await A.settle();
  await A.pull();
  eq('S10.6 the board settles on exactly one basket', A.points(), 3);
  eq('S10.7 and so does the server', server.count('events'), 1);
}

/* ==========================================================================
   GROUP S11 - "the last event" must mean the same row on both sides
   ==========================================================================
   Undo removes the last event of the game. The device used to read that off
   array position and the server off `ts` alone, so a redone event (appended
   locally, re-sorted server-side) and two taps inside one millisecond could
   make the two disagree about which row that is.
*/

async function s11_canonical_order_is_shared() {
  const server = new FakeServer();
  const A = await seed(server);

  for (const type of ['2pm', '3pm', 'ftm', 'reb']) {
    A.dispatch(score('lg1', 'g1', 'tH', 'p1', type, 1));
  }
  await A.settle();
  const order0 = A.eventIds();
  eq('S11.1 four events logged', order0.length, 4);

  await A.pull();
  eq('S11.2 the local order was already the server order', A.eventIds(), order0);

  // Undo and redo must round-trip to the SAME order, not shuffle the row to the
  // end. Redo used to append, which put a restored row after rows with a later
  // ts on the device while the server kept it in place.
  A.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  await A.settle();
  eq('S11.3 undo took the canonically-last row', A.eventIds(), order0.slice(0, 3));
  A.dispatch({ t: 'REDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  await A.settle();
  eq('S11.4 redo restores it in its own place', A.eventIds(), order0);
  await A.pull();
  eq('S11.5 and a pull agrees', A.eventIds(), order0);

  // Deleting a row from the MIDDLE of the play-by-play must not disturb the
  // order of the rest, on either side.
  const middle = order0[1];
  A.dispatch({ t: 'DELETE_EVENT', leagueId: 'lg1', gameId: 'g1', eventId: middle });
  await A.settle();
  const expected = order0.filter(id => id !== middle);
  eq('S11.6 the remaining rows keep their order', A.eventIds(), expected);
  ok('S11.7 the row is gone server-side', !server.has('events', middle));
  await A.pull();
  eq('S11.8 and stays gone, in order, after a pull', A.eventIds(), expected);

  const B = new Device('B', server);
  await B.pull();
  eq('S11.9 a second device reads the same order', B.eventIds(), expected);

  // The next undo names the same row on both sides.
  const target = expected[expected.length - 1];
  A.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  await A.settle();
  ok('S11.10 undo removed the canonical last row locally', !A.eventIds().includes(target));
  ok('S11.11 and the same row server-side', !server.has('events', target));
}

/* Same-millisecond taps: `ts` ties, so only the id tie-break keeps the two
   sides in step. Without it PostgREST is free to return them either way round
   and Undo becomes a coin flip. */
async function s12_same_millisecond_taps() {
  const server = new FakeServer();
  const A = await seed(server);

  for (let i = 0; i < 6; i++) A.dispatch(score('lg1', 'g1', 'tH', 'p1', 'ftm', 1));
  await A.settle();

  const localOrder = A.eventIds();
  eq('S12.1 six free throws logged', localOrder.length, 6);

  // Shuffle the server's storage order. A real Postgres offers no guarantee
  // here, and the client must not depend on one.
  server.rows.events.reverse();

  await A.pull();
  eq('S12.2 the pulled order is the canonical one, not the storage one', A.eventIds(), localOrder);

  const last = localOrder[localOrder.length - 1];
  A.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  await A.settle();
  ok('S12.3 undo targeted the canonical last row', !server.has('events', last));
  eq('S12.4 five left', A.points(), 5);
}

/* ==========================================================================
   GROUP S13 - a push that fails must not silently revert the board later
   ==========================================================================
   This is the state the reported logs were taken in: every write returning
   "TypeError: Network request failed". The old tombstone expired after twelve
   seconds and the next snapshot then quietly rewrote the score. A scorekeeper
   cannot be shown a number that changes on its own minutes after the play.
*/

async function s13_failed_push_pins_the_local_value() {
  const server = new FakeServer();
  const A = await seed(server);

  server.failures['insert:events'] = 'network';
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', '3pm', 1));
  await A.settle();

  eq('S13.1 the stat stays on the board', A.points(), 3);
  eq('S13.2 the sync badge reports the failure', A.syncState, 'error');
  eq('S13.3 nothing reached the server', server.count('events'), 0);

  // Connection returns; a fresh snapshot arrives that still has no such row.
  delete server.failures['insert:events'];
  await A.pull();
  eq('S13.4 an unsynced stat is not deleted behind the scorekeeper', A.points(), 3);

  // A failed UNDO is the mirror case: the row is still on the server, but the
  // board must not hand the basket back on its own.
  const survivor = A.eventIds()[0];
  server.failures['delete:events'] = 'network';
  A.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  await A.settle();
  eq('S13.5 the undo holds locally', A.points(), 0);
  eq('S13.6 and is reported as failed', A.syncState, 'error');

  delete server.failures['delete:events'];
  // Put the row on the server so a pull WOULD resurrect it if nothing pinned it.
  server.rows.events.push({
    id: survivor, league_id: 'lg1', game_id: 'g1', team_id: 'tH', player_id: 'p1',
    type: '3pm', period: 1, ts: 1, note: null,
  });
  await A.pull();
  eq('S13.7 a failed undo is not reversed by a later pull', A.points(), 0);
}

/* A burst of taps and undos faster than any round trip. Every dispatch reads
   the synchronous pre-state, so the arithmetic must be exact regardless of how
   the pushes interleave. */
async function s14_rapid_undo_redo_burst() {
  const server = new FakeServer();
  const A = await seed(server);
  server.latency['insert:events'] = 25;
  server.latency['delete:events'] = 5;

  A.dispatch(score('lg1', 'g1', 'tH', 'p1', '3pm', 1));
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', '3pm', 1));
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', '3pm', 1));
  eq('S14.1 three baskets', A.points(), 9);
  A.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  A.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  eq('S14.2 two undos leave one', A.points(), 3);

  await A.settle();
  await A.pull();
  eq('S14.3 the board catches up to exactly one basket', A.points(), 3);
  eq('S14.4 the server holds one row', server.count('events'), 1);

  A.dispatch({ t: 'REDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  A.dispatch({ t: 'REDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  eq('S14.5 two redos bring both back', A.points(), 9);
  await A.settle();
  await A.pull();
  eq('S14.6 and survive a pull', A.points(), 9);
  eq('S14.7 with no duplicate rows', server.count('events'), 3);

  const B = new Device('B', server);
  await B.pull();
  eq('S14.8 the other device agrees', B.points(), 9);
}

/* The ledger must not leak. Once the server has confirmed a write and a later
   snapshot has been read, the entry is retired - otherwise a long game would
   pin every event it ever logged. */
async function s15_ledger_retires_confirmed_writes() {
  const server = new FakeServer();
  const A = await seed(server);
  for (let i = 0; i < 5; i++) A.dispatch(score('lg1', 'g1', 'tH', 'p1', '2pm', 1));
  await A.settle();
  ok('S15.1 writes are held while unreconciled', pendingCount() > 0, 'count=' + pendingCount());
  await A.pull();
  eq('S15.2 a snapshot read after confirmation retires them', pendingCount(), 0);
  eq('S15.3 without changing the score', A.points(), 10);
}


/* ==========================================================================
   GROUP S16 - an all-or-nothing bundle that fails must not survive locally
   ==========================================================================
   Reported: the drop-in setup showed "Could not save ... REC_setup_game: Sign
   in to start a drop-in game", and the game was in the list afterwards anyway.
   Opening it worked; every write inside it then failed, because none of the
   rows it referenced existed server-side. Cancelling the alert changed nothing,
   because nothing ever undid the local half.

   rec_setup_game and bulk_import_roster are each ONE server transaction, so a
   failure means none of it was written. The local state has to match.
*/

async function s16_failed_drop_in_rolls_back() {
  const server = new FakeServer();
  const A = new Device('A', server);

  server.failures['rpc:rec_setup_game'] = { message: 'Sign in to start a drop-in game.' };

  A.dispatch({
    t: 'REC_SETUP_GAME',
    leagueId: 'rec-me', gameId: 'gRec', location: 'Gym',
    ensureLeague: { name: 'Private Drop-In Games' },
    teams: [
      { id: 'tA', name: 'Alpha', color: '#111', players: [{ id: 'pa', name: 'A' }] },
      { id: 'tB', name: 'Bravo', color: '#222', players: [{ id: 'pb', name: 'B' }] },
    ],
  });

  // Before the push settles the game is on screen - that is the point of an
  // optimistic write, and it is correct.
  ok('S16.1 the game shows immediately', !!A.state.leagues.find(l => l.id === 'rec-me'));

  await A.settle();

  eq('S16.2 the failure is reported', A.syncState, 'error');
  eq('S16.3 the server holds no game', server.count('games'), 0);
  eq('S16.4 nor any teams or players', [server.count('teams'), server.count('players')], [0, 0]);
  ok('S16.5 the half-created space is gone locally too',
     !A.state.leagues.find(l => l.id === 'rec-me'),
     JSON.stringify(A.state.leagues.map(l => l.id)));

  // A pull must not resurrect it either.
  await A.pull();
  ok('S16.6 and a pull does not bring it back', !A.state.leagues.find(l => l.id === 'rec-me'));
}

/* The same failure inside a space that ALREADY existed must take only the
   bundle's own rows, never the space or anything previously in it. */
async function s17_rollback_spares_an_existing_space() {
  const server = new FakeServer();
  const A = await seed(server);

  // A drop-in game added to the existing league, which then fails to save.
  server.failures['rpc:rec_setup_game'] = { message: 'Scorekeeper access required.' };
  A.dispatch({
    t: 'REC_SETUP_GAME',
    leagueId: 'lg1', gameId: 'gRec', location: 'Gym',
    teams: [
      { id: 'tNew1', name: 'Alpha', color: '#111', players: [{ id: 'pNew1', name: 'A' }] },
      { id: 'tNew2', name: 'Bravo', color: '#222', players: [{ id: 'pNew2', name: 'B' }] },
    ],
  });
  await A.settle();

  const l = A.league();
  ok('S17.1 the existing league survives', !!l);
  eq('S17.2 its original teams are untouched', l.teams.map(t => t.id), ['tH', 'tA']);
  eq('S17.3 its original players are untouched', l.players.map(p => p.id), ['p1', 'p2']);
  eq('S17.4 its original game is untouched', l.games.map(g => g.id), ['g1']);
  ok('S17.5 the failed bundle left no game behind', !l.games.some(g => g.id === 'gRec'));
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
  ['S9 pending insert vs stale snapshot', s9_pending_insert_survives_a_stale_snapshot],
  ['S10 undo, tap, stale snapshot', s10_undo_then_tap_then_stale_snapshot],
  ['S11 canonical order is shared', s11_canonical_order_is_shared],
  ['S12 same-millisecond taps', s12_same_millisecond_taps],
  ['S13 failed push pins the board', s13_failed_push_pins_the_local_value],
  ['S14 rapid undo/redo burst', s14_rapid_undo_redo_burst],
  ['S15 ledger retires confirmed writes', s15_ledger_retires_confirmed_writes],
  ['S16 failed drop-in rolls back', s16_failed_drop_in_rolls_back],
  ['S17 rollback spares an existing space', s17_rollback_spares_an_existing_space],
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
