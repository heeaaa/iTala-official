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
// push queue, the pending-writes ledger and the snapshot watermark) are imported
// from the app, not reimplemented here - see tests/static.test.js for the check
// that StoreProvider actually wires them up.

const M = require(process.env.ITALA_BUNDLE || '../.test-bundle.js');
const { FakeServer, makeClient } = require('./harness/fakeSupabase.js');

const {
  reducer, pushAction, fetchAllState,
  // The dispatch-side sync primitives. Imported, not reimplemented: if one of
  // these is removed the suite fails to load rather than quietly testing a copy
  // of behaviour the app no longer has.
  stampActionIds, enqueuePush,
  beginSnapshot, acceptSnapshot, appliedSnapshotAt,
  recordPending, confirmPending, failPending, pendingCount,
  __resetSyncPrimitives: resetSyncPrimitives,
} = M;

for (const [name, fn] of Object.entries({
  reducer, pushAction, fetchAllState, stampActionIds, enqueuePush,
  beginSnapshot, acceptSnapshot, appliedSnapshotAt,
  recordPending, confirmPending, failPending, pendingCount,
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
    // Why the last snapshot was refused, if it was: 'empty' | 'stale' | null.
    this.refused = null;
  }

  dispatch(incoming) {
    if (incoming.t === 'HYDRATE') { this.state = reducer(this.state, incoming); return; }

    const action = stampActionIds(this.state, incoming);
    // Capture the post-dispatch state, exactly as StoreProvider does. pushAction
    // reads "the row this action produced" out of it, so it must be the snapshot
    // from THIS dispatch and not whatever the device holds when the queued push
    // eventually runs.
    const prev = this.state;
    const next = reducer(prev, action);
    this.state = next;

    // Record the write in the pending ledger before the push starts, so a
    // snapshot landing mid-flight is reconciled against it rather than
    // overwriting it. Same call the app makes: prev and next together, so the
    // ledger can see whether the game row moved as well as the event list.
    const touched = recordPending(action, prev, next);

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
  // The same two gates StoreProvider.applySnapshot puts in front of HYDRATE:
  // never hydrate an empty read over a device that has data, and never hydrate a
  // snapshot older than one already applied. Returns whether it was applied.
  applySnapshot(snap) {
    const leagues = snap.remote && snap.remote.leagues;
    if (!leagues) return false;
    if (leagues.length === 0 && this.state.leagues.length > 0) { this.refused = 'empty'; return false; }
    if (!acceptSnapshot(snap.at)) { this.refused = 'stale'; return false; }
    this.dispatch({ t: 'HYDRATE', state: { leagues }, snapshotAt: snap.at });
    return true;
  }

  league(id = 'lg1') { return this.state.leagues.find(l => l.id === id); }
  game(gameId = 'g1', leagueId = 'lg1') {
    const l = this.league(leagueId);
    return l && l.games.find(g => g.id === gameId);
  }
  eventIds(gameId = 'g1') {
    const l = this.league();
    return (l ? l.events : []).filter(e => e.gameId === gameId).map(e => e.id);
  }
  points(gameId = 'g1') {
    const l = this.league();
    // The short names are this suite's own shorthand, kept because every group
    // below already reads in them; the fg2_make/fg3_make/ft_make spellings are
    // the app's real EventType values, used by the groups added for the
    // stale-snapshot work so they exercise the reducer's actual vocabulary.
    const val = { '3pm': 3, '2pm': 2, ftm: 1, fg3_make: 3, fg2_make: 2, ft_make: 1 };
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

/* Same-millisecond taps. `stampActionIds` now takes `ts` as strictly after the
   latest event already logged for the game, so a burst does not tie in the first
   place - which is what makes Undo remove the tap the scorekeeper just made
   rather than whichever tied row sorted last (see S25). The id tie-break behind
   it still has to hold, for rows this device did not mint: two devices inside one
   millisecond, and rows already stored by an older build. Without it PostgREST is
   free to return tied rows either way round. */
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

/* ==========================================================================
   GROUP S18 - THE REPORTED BUG, with no undo, no redo and one device
   ==========================================================================
   The ledger answers "may this snapshot overwrite my pending write?". It does
   not answer "has a NEWER snapshot already been applied?", and that gap loses a
   committed stat on its own:

     pull A starts, reads no events, its reply is slow in transit
     tap 3PT                    -> 3, the ledger protects it
     INSERT confirmed
     pull B reads one event, lands first, and the ledger entry RETIRES
                                   (correctly - the server really does have it)
     pull A finally lands       -> 0     <- the basket is gone

   Nothing pulls again, because nothing changed on the server, so the board sits
   wrong indefinitely. Before the fix there were five uncoordinated pull sites
   (boot, boot retry, post-auth re-pull, realtime refetch, pull-to-refresh), so
   two of them overlapping was ordinary rather than exotic.
*/

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function s18_out_of_order_snapshot_cannot_revert_a_stat() {
  const server = new FakeServer();
  const A = await seed(server);

  // A pull is already on the wire when the tap happens.
  const stale = await A.snapshot();
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', 'fg3_make', 1));
  eq('S18.1 the tap shows immediately', A.points(), 3);
  await A.settle();

  const fresh = await A.snapshot();
  ok('S18.2 the newer snapshot is applied', A.applySnapshot(fresh));
  eq('S18.3 the score is right', A.points(), 3);
  eq('S18.4 and the ledger has legitimately retired the write', pendingCount(), 0);

  ok('S18.5 the older reply is refused', A.applySnapshot(stale) === false);
  eq('S18.6 refused for being out of order', A.refused, 'stale');
  eq('S18.7 a committed stat does not revert', A.points(), 3);
  eq('S18.8 and the server was right all along', server.count('events'), 1);
}

/* The same shape with a second tap still in flight, which is what a scorekeeper
   working at speed actually looks like. */
async function s19_out_of_order_snapshot_with_a_later_tap_pending() {
  const server = new FakeServer();
  const A = await seed(server);
  const stale = await A.snapshot();

  A.dispatch(score('lg1', 'g1', 'tH', 'p1', 'fg2_make', 1));
  await A.settle();
  A.applySnapshot(await A.snapshot());          // retires tap 1
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', 'ft_make', 1)); // tap 2 still pending
  eq('S19.1 three points on the board', A.points(), 3);

  ok('S19.2 the stale reply is refused', A.applySnapshot(stale) === false);
  eq('S19.3 both taps survive', A.points(), 3);
  await A.settle();
  A.applySnapshot(await A.snapshot());
  eq('S19.4 and both are on the server', server.count('events'), 2);
}

/* ==========================================================================
   GROUP S20 - one ledger slot per event was one too few
   ==========================================================================
   The ledger used to be keyed by event id alone, so an ADD and the UNDO of that
   same row shared a slot, and `confirmPending(eventId)` could not tell which of
   the two it was acknowledging. Undoing a mis-tap therefore ended with the
   INSERT's acknowledgement stamped onto the UNDO's entry: the next snapshot
   retired the undo and handed the basket straight back.
*/

async function s20_insert_confirmation_does_not_retire_the_undo() {
  const server = new FakeServer();
  const A = await seed(server);
  server.latency['insert:events'] = 5;
  server.latency['delete:events'] = 200;   // the DELETE is still on the wire

  A.dispatch(score('lg1', 'g1', 'tH', 'p1', 'fg3_make', 1));
  const evId = A.eventIds()[0];
  A.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  eq('S20.1 the undo clears the board', A.points(), 0);

  await sleep(60);                          // INSERT confirmed, DELETE pending
  eq('S20.2 the row is on the server', server.has('events', evId), true);

  ok('S20.3 the snapshot is applied, not refused', A.applySnapshot(await A.snapshot()));
  eq('S20.4 the undone basket must not come back', A.points(), 0);

  await A.settle();
  A.applySnapshot(await A.snapshot());
  eq('S20.5 final score', A.points(), 0);
  eq('S20.6 and the row is gone server-side', server.count('events'), 0);
}

/* And the mirror image: a redo whose re-INSERT is still queued behind the
   DELETE it is undoing must not be retired by that DELETE's acknowledgement. */
async function s21_delete_confirmation_does_not_retire_the_redo() {
  const server = new FakeServer();
  const A = await seed(server);
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', 'fg3_make', 1));
  await A.settle();
  A.applySnapshot(await A.snapshot());
  eq('S21.1 baseline', A.points(), 3);
  eq('S21.2 ledger clear', pendingCount(), 0);

  server.latency['delete:events'] = 5;
  server.latency['upsert:events'] = 200;   // the redo's re-INSERT is slow

  A.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  A.dispatch({ t: 'REDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  eq('S21.3 redo restores it locally', A.points(), 3);

  await sleep(60);                          // DELETE confirmed, re-INSERT pending
  eq('S21.4 the server is empty for the moment', server.count('events'), 0);

  ok('S21.5 the snapshot is applied, not refused', A.applySnapshot(await A.snapshot()));
  eq('S21.6 the redone basket must survive it', A.points(), 3);

  await A.settle();
  A.applySnapshot(await A.snapshot());
  eq('S21.7 final score', A.points(), 3);
  eq('S21.8 with exactly one row', server.count('events'), 1);
}

/* ==========================================================================
   GROUP S22 - an empty read is not proof the account owns nothing
   ==========================================================================
   An RLS read taken while the access token is mid-refresh returns [] rather
   than an error. The post-auth re-pull hydrated that unconditionally, which
   wiped every league on the device until the next successful pull. The boot pull
   always checked; nothing else did.
*/

async function s22_an_empty_snapshot_never_wipes_a_device() {
  const server = new FakeServer();
  const A = await seed(server);
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', 'fg2_make', 1));
  await A.settle();
  A.applySnapshot(await A.snapshot());
  eq('S22.1 baseline', A.points(), 2);

  const empty = { at: beginSnapshot(), remote: { leagues: [] } };
  ok('S22.2 an empty read is refused', A.applySnapshot(empty) === false);
  eq('S22.3 refused for being empty', A.refused, 'empty');
  ok('S22.4 the league survives', !!A.league());
  eq('S22.5 and so does the score', A.points(), 2);

  // But a device that genuinely has nothing must still be able to settle on
  // "nothing", or a fresh install would sit on a loading state forever.
  const B = new Device('B', new FakeServer());
  ok('S22.6 a device with no data accepts an empty read',
     B.applySnapshot({ at: beginSnapshot(), remote: { leagues: [] } }));
}

/* ==========================================================================
   GROUP S23 - the game row gets the same guarantee as the events
   ==========================================================================
   Lineups, substitutions, the period and the status used to be protected by
   `lineupGuard`: a 2.5-second tombstone in StoreProvider. Same shape of answer
   as the undo tombstone that preceded the ledger, and the same two failure
   modes - too short for a slow push, and wrong the instant its clock ran out.
   A substitution is as much a committed user action as a basket.
*/

async function s23_game_row_ledger_protects_a_substitution() {
  const server = new FakeServer();
  const A = await seed(server);
  A.dispatch({ t: 'ADD_PLAYER', leagueId: 'lg1', teamId: 'tH', name: 'Bench', id: 'p3' });
  A.dispatch({ t: 'SET_LINEUP', leagueId: 'lg1', gameId: 'g1', side: 'home', playerIds: ['p1'] });
  await A.settle();
  A.applySnapshot(await A.snapshot());
  eq('S23.1 the lineup is on the board', A.game().homeOnCourt, ['p1']);
  eq('S23.2 and the ledger is clear', pendingCount(), 0);

  // A refetch reads the pre-substitution row...
  const inFlight = await A.snapshot();
  // ...the scorekeeper subs, and the upsert is slow...
  server.latency['upsert:games'] = 200;
  A.dispatch({ t: 'SUBSTITUTE', leagueId: 'lg1', gameId: 'g1', side: 'home', outId: 'p1', inId: 'p3' });
  eq('S23.3 the sub is immediate locally', A.game().homeOnCourt, ['p3']);

  // ...and that snapshot lands while the upsert is still on the wire. Nothing
  // newer has been applied, so the watermark has no opinion here: the ledger is
  // the only thing that can stop this reverting the substitution.
  ok('S23.4 the snapshot is applied, not refused', A.applySnapshot(inFlight));
  eq('S23.5 the substitution survives it', A.game().homeOnCourt, ['p3']);

  await A.settle();
  A.applySnapshot(await A.snapshot());
  eq('S23.6 and survives the echo of its own write', A.game().homeOnCourt, ['p3']);
  eq('S23.7 the server agrees', server.find('games', 'g1').home_on_court, ['p3']);
}

/* The period is on the same row, and moves for the same reason. */
async function s24_game_row_ledger_protects_the_period() {
  const server = new FakeServer();
  const A = await seed(server);
  A.applySnapshot(await A.snapshot());
  const inFlight = await A.snapshot();
  server.latency['upsert:games'] = 200;
  A.dispatch({ t: 'SET_PERIOD', leagueId: 'lg1', gameId: 'g1', period: 3 });
  eq('S24.1 period advanced locally', A.game().period, 3);
  ok('S24.2 the stale-read snapshot is applied', A.applySnapshot(inFlight));
  eq('S24.3 the period does not fall back', A.game().period, 3);
  await A.settle();
  A.applySnapshot(await A.snapshot());
  eq('S24.4 and it round-trips', A.game().period, 3);
}

/* ==========================================================================
   GROUP S25 - ADD_EVENT must be stamped once, not once per reducer run
   ==========================================================================
   The reducer runs TWICE per action in this app: once in the dispatch wrapper,
   to build the rows the push mirrors, and again inside React's useReducer for
   the state the UI renders. `ts: Date.now()` inside the reducer therefore gave
   the server row and the on-screen row different timestamps - and `ts` is half
   of the (ts, id) key that makes "the last event of this game" name the same row
   on both sides, which is the whole definition of Undo.
*/

function s25_add_event_is_stamped_once() {
  let st = { leagues: [] };
  st = reducer(st, { t: 'ADD_LEAGUE', id: 'lg1', name: 'BPBL', season: 'S3' });
  st = reducer(st, { t: 'ADD_TEAM', leagueId: 'lg1', name: 'Warriors', id: 'tH' });
  st = reducer(st, { t: 'CREATE_GAME', id: 'g1', leagueId: 'lg1', homeTeamId: 'tH', awayTeamId: 'tA' });

  const action = stampActionIds(st, score('lg1', 'g1', 'tH', 'p1', 'fg3_make', 1));
  ok('S25.1 the action carries an id', typeof action.id === 'string' && action.id.length > 0);
  ok('S25.2 the action carries a ts', typeof action.ts === 'number');

  const runA = reducer(st, action);
  const t0 = Date.now();
  while (Date.now() === t0) { /* cross a millisecond boundary, as a slow render does */ }
  const runB = reducer(st, action);

  eq('S25.3 both reducer runs stamp the same ts',
     runA.leagues[0].events[0].ts, runB.leagues[0].events[0].ts);
  eq('S25.4 and the same id',
     runA.leagues[0].events[0].id, runB.leagues[0].events[0].id);
  eq('S25.5 re-stamping an already-stamped action changes nothing',
     stampActionIds(st, action), action);
}

/* ==========================================================================
   GROUP S26 - the reported reproduction scenarios, end to end
   ==========================================================================
   Every step is followed by a full round trip and re-hydrate, which is what
   "wait a few seconds", "navigate away and back" and "reload the screen" all
   reduce to in this architecture: the state comes from the store, and the store
   is re-hydrated from the server.
*/

async function s26_reported_scenarios_end_to_end() {
  const server = new FakeServer();
  const A = await seed(server);
  const ev = (type) => score('lg1', 'g1', 'tH', 'p1', type, 1);
  const roundTrip = async () => { await A.settle(); A.applySnapshot(await A.snapshot()); };

  // Scenario 1 - one stat update, then wait.
  A.dispatch(ev('fg2_make'));
  eq('S26.1 two points', A.points(), 2);
  await roundTrip();
  eq('S26.2 still two after a round trip', A.points(), 2);

  // Scenario 2 - several updates, mixing scoring, misses and non-scoring stats.
  A.dispatch(ev('fg3_make'));
  A.dispatch(ev('fg2_miss'));
  A.dispatch(ev('reb'));
  A.dispatch(ev('tov'));
  A.dispatch(ev('ft_make'));
  eq('S26.3 six points', A.points(), 6);
  eq('S26.4 six events in the log', A.eventIds().length, 6);
  await roundTrip();
  eq('S26.5 all six survive', A.points(), 6);
  eq('S26.6 and the log is intact', A.eventIds().length, 6);

  // Scenarios 3 and 4 - undo moves exactly one step back, and stays there.
  A.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  eq('S26.7 undo drops the free throw only', A.points(), 5);
  eq('S26.8 five events remain', A.eventIds().length, 5);
  await roundTrip();
  eq('S26.9 the undo holds', A.points(), 5);
  eq('S26.10 and so does the log', A.eventIds().length, 5);

  // Scenario 5 - redo moves exactly one step forward, and stays there.
  A.dispatch({ t: 'REDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  eq('S26.11 redo restores the free throw', A.points(), 6);
  await roundTrip();
  eq('S26.12 the redo holds', A.points(), 6);
  eq('S26.13 with no duplicate row', server.count('events'), 6);

  // Scenario 6 - a new action after undo invalidates the redo branch.
  A.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  eq('S26.14 back to five', A.points(), 5);
  A.dispatch(ev('ft_make'));
  eq('S26.15 a new free throw takes it to six', A.points(), 6);
  A.dispatch({ t: 'REDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  eq('S26.16 redo after a new action does nothing', A.points(), 6);
  await roundTrip();
  eq('S26.17 and the round trip agrees', A.points(), 6);
  eq('S26.18 six rows server-side, not seven', server.count('events'), 6);

  // Scenario 7 - a substitution alongside the stats.
  A.dispatch({ t: 'ADD_PLAYER', leagueId: 'lg1', teamId: 'tH', name: 'Bench', id: 'p3' });
  A.dispatch({ t: 'SET_LINEUP', leagueId: 'lg1', gameId: 'g1', side: 'home', playerIds: ['p1'] });
  A.dispatch({ t: 'SUBSTITUTE', leagueId: 'lg1', gameId: 'g1', side: 'home', outId: 'p1', inId: 'p3' });
  A.dispatch(ev('fg3_make'));
  eq('S26.19 nine points', A.points(), 9);
  await roundTrip();
  eq('S26.20 the score survives the sub', A.points(), 9);
  eq('S26.21 and so does the lineup', A.game().homeOnCourt, ['p3']);

  // Scenario 10 - a rapid burst, then wait.
  A.dispatch(ev('fg2_make'));
  A.dispatch(ev('fg3_make'));
  A.dispatch(ev('ft_make'));
  A.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  A.dispatch({ t: 'REDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  A.dispatch(ev('fg2_make'));
  const settled = A.points();
  eq('S26.22 the burst arithmetic is exact', settled, 9 + 2 + 3 + 1 + 2);
  await roundTrip();
  eq('S26.23 and it is deterministic across the round trip', A.points(), settled);

  // Scenario 9 - a cold reload sees exactly the same board.
  const B = new Device('B', server);
  await B.pull();
  eq('S26.24 a freshly loaded device agrees on the score', B.points(), settled);
  eq('S26.25 and on the log', B.eventIds().length, A.eventIds().length);
  eq('S26.26 and on the lineup', B.game().homeOnCourt, ['p3']);
}

/* ==========================================================================
   GROUP S27 - a pinned game write must not resurrect a rolled-back game
   ==========================================================================
   Putting the game row into the ledger creates a trap the events never had. A
   FAILED write is pinned rather than retired, deliberately, so the scorekeeper's
   value stays on the board - but a drop-in game whose transaction was rejected
   is ROLLED BACK locally, and a pinned entry would then put it straight back on
   the next pull, pointing at teams and players the rollback also removed. Which
   is the "?" team crash the bundle guard exists to prevent, reintroduced through
   the back door.

   The rule that closes it is not a list of actions to special-case: a ledger
   entry is a local write held open until the server agrees, so an entry whose row
   is no longer on the device has nothing left to protect.
*/

async function s27_a_failed_bundle_is_not_resurrected_by_the_ledger() {
  const server = new FakeServer();
  const A = await seed(server);
  A.applySnapshot(await A.snapshot());

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
  ok('S27.1 the push was rejected', A.syncState === 'error');
  ok('S27.2 the local half is rolled back', !A.game('gRec'));

  // The pull that follows must not hand the rolled-back game back.
  A.applySnapshot(await A.snapshot());
  ok('S27.3 a pinned game write does not resurrect it', !A.game('gRec'));
  eq('S27.4 the existing game is untouched', A.league().games.map(g => g.id), ['g1']);
  eq('S27.5 and the ledger has let it go', pendingCount(), 0);
}

/* Deleting a game after a substitution whose push failed is the same shape
   without the bundle: the pinned entry must not bring the game back either. */
async function s28_deleting_a_game_releases_its_pending_write() {
  const server = new FakeServer();
  const A = await seed(server);
  A.dispatch({ t: 'ADD_PLAYER', leagueId: 'lg1', teamId: 'tH', name: 'Bench', id: 'p3' });
  A.dispatch({ t: 'SET_LINEUP', leagueId: 'lg1', gameId: 'g1', side: 'home', playerIds: ['p1'] });
  await A.settle();
  A.applySnapshot(await A.snapshot());

  server.failures['upsert:games'] = 'network';
  A.dispatch({ t: 'SUBSTITUTE', leagueId: 'lg1', gameId: 'g1', side: 'home', outId: 'p1', inId: 'p3' });
  await A.settle();
  eq('S28.1 the sub stands locally despite the failure', A.game().homeOnCourt, ['p3']);

  delete server.failures['upsert:games'];
  A.dispatch({ t: 'DELETE_GAME', leagueId: 'lg1', gameId: 'g1' });
  await A.settle();
  ok('S28.2 the game is gone locally', !A.game());
  A.applySnapshot(await A.snapshot());
  ok('S28.3 and the pinned sub does not bring it back', !A.game());
}

/* ==========================================================================
   GROUP S29 - a resolved push is not proof the server has the row
   ==========================================================================
   THE REPORTED BUG, and the one the earlier fixes did not cover. Arm 2PT, tap a
   player: the log shows "made 2", the score goes to 2, and about a second later
   it is 0 with an empty play-by-play. No error, no red badge, nothing in the log.

   The chain: the push RESOLVED without the row reaching the server, so the
   ledger was told the server had it; the next snapshot started after that
   moment, so the entry was eligible for retirement; and it was retired without
   anyone checking whether the rows in hand actually contained it. They did not,
   so the server's version - which had no such event - won.

   `acceptSnapshot` (the watermark) cannot catch this: the snapshot is the newest
   one, it is simply missing the row. Ordering was never the whole question.

   The rule now: ordering decides ELIGIBILITY, the snapshot's CONTENT decides
   confirmation. An add retires only when the snapshot contains the event; a
   remove only when it does not.
*/

async function s29_a_resolved_push_without_the_row_keeps_the_stat() {
  const server = new FakeServer();
  const A = await seed(server);
  A.applySnapshot(await A.snapshot());
  eq('S29.1 clean ledger to start', pendingCount(), 0);

  // The server accepts the request and writes nothing - RLS as a silent filter,
  // which is what this emulator exists to model, and the same shape as a push
  // that returns early without inserting.
  server.rls.events = (_row, op) => op !== 'insert';

  A.dispatch(score('lg1', 'g1', 'tH', 'p1', 'fg2_make', 1));
  const evId = A.eventIds()[0];
  eq('S29.2 the tap shows immediately', A.points(), 2);
  await A.settle();

  ok('S29.3 the row really is not on the server', !server.has('events', evId));
  ok('S29.4 and the push reported success, not failure', A.syncState === 'saved',
     `syncState was '${A.syncState}'`);

  // The snapshot is the NEWEST one and starts after the confirmation, so the
  // watermark has no opinion. Only the content check stands between the
  // scorekeeper and a stat that vanishes.
  ok('S29.5 the snapshot is applied, not refused', A.applySnapshot(await A.snapshot()));
  eq('S29.6 the stat is still on the board', A.points(), 2);
  eq('S29.7 and still in the play-by-play', A.eventIds().length, 1);
  ok('S29.8 the ledger did NOT retire an unreflected write', pendingCount() > 0,
     'retiring it is what deleted the stat');

  // It must keep surviving, not survive once.
  A.applySnapshot(await A.snapshot());
  A.applySnapshot(await A.snapshot());
  eq('S29.9 it survives repeated snapshots', A.points(), 2);

  // And once the server really does accept it, everything converges and the
  // ledger lets go - no permanent leak.
  delete server.rls.events;
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', 'ft_make', 1));
  await A.settle();
  A.applySnapshot(await A.snapshot());
  eq('S29.10 the later write lands', server.count('events'), 1);
  eq('S29.11 the board is the sum of what it has', A.points(), 3);
}

/* The mirror direction, as a guard on the retirement change itself: making an
   ADD retire only when the snapshot contains it must not weaken the REMOVE side.
   A delete the server did not perform is caught upstream by the read-back in
   pushAction (see S6), so this passes with or without the content rule - it is
   here to fail if the rule is ever written in a way that lets an undone event
   back onto the board. */
async function s30_an_acknowledged_delete_that_did_nothing_keeps_the_undo() {
  const server = new FakeServer();
  const A = await seed(server);
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', 'fg3_make', 1));
  await A.settle();
  A.applySnapshot(await A.snapshot());
  eq('S30.1 baseline', A.points(), 3);
  eq('S30.2 clean ledger', pendingCount(), 0);

  // The delete is acknowledged, the row survives, AND the read-back that would
  // normally catch it is filtered too - so the push cannot tell and resolves.
  server.rls.events = (_row, op) => op === 'insert' || op === 'select' ? true : false;
  A.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  await A.settle();
  eq('S30.3 the undo cleared the board locally', A.points(), 0);

  A.applySnapshot(await A.snapshot());
  eq('S30.4 the undone basket does not come back', A.points(), 0);
  ok('S30.5 the ledger kept the unreflected removal', pendingCount() > 0);
}

/* A push asked to mirror a row it cannot find must REPORT, not resolve. Left as
   a quiet `return`, it told the ledger the server had a row nobody ever wrote -
   the same lie as above, reachable without any server misbehaviour at all. */
async function s31_a_push_with_nothing_to_write_reports_failure() {
  const server = new FakeServer();
  const A = await seed(server);

  // A well-formed ADD_EVENT for a league this state does not contain: exactly
  // what a queued push sees after a rolled-back bundle or a deleted game.
  const orphan = {
    t: 'ADD_EVENT', leagueId: 'lgGone', gameId: 'g1', teamId: 'tH',
    playerId: 'p1', type: 'fg2_make', period: 1, id: 'evOrphan', ts: 1,
  };
  let threw = null;
  try {
    await pushAction(A.client, orphan, A.state);
  } catch (e) {
    threw = (e && e.message) || String(e);
  }
  ok('S31.1 it throws rather than resolving', !!threw, 'a quiet resolve is read as "the server has it"');
  ok('S31.2 and the message names what was missing',
     !!threw && /ADD_EVENT/.test(threw) && /evOrphan/.test(threw) && /lgGone/.test(threw), threw);
  eq('S31.3 nothing was written', server.count('events'), 0);
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
  ['S18 out-of-order snapshot cannot revert a stat', s18_out_of_order_snapshot_cannot_revert_a_stat],
  ['S19 out-of-order snapshot with a later tap pending', s19_out_of_order_snapshot_with_a_later_tap_pending],
  ['S20 insert confirmation does not retire the undo', s20_insert_confirmation_does_not_retire_the_undo],
  ['S21 delete confirmation does not retire the redo', s21_delete_confirmation_does_not_retire_the_redo],
  ['S22 an empty snapshot never wipes a device', s22_an_empty_snapshot_never_wipes_a_device],
  ['S23 game-row ledger protects a substitution', s23_game_row_ledger_protects_a_substitution],
  ['S24 game-row ledger protects the period', s24_game_row_ledger_protects_the_period],
  ['S25 ADD_EVENT is stamped once', s25_add_event_is_stamped_once],
  ['S26 reported scenarios end to end', s26_reported_scenarios_end_to_end],
  ['S27 a failed bundle is not resurrected by the ledger', s27_a_failed_bundle_is_not_resurrected_by_the_ledger],
  ['S28 deleting a game releases its pending write', s28_deleting_a_game_releases_its_pending_write],
  ['S29 a resolved push without the row keeps the stat', s29_a_resolved_push_without_the_row_keeps_the_stat],
  ['S30 an acknowledged delete that did nothing keeps the undo', s30_an_acknowledged_delete_that_did_nothing_keeps_the_undo],
  ['S31 a push with nothing to write reports failure', s31_a_push_with_nothing_to_write_reports_failure],
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
