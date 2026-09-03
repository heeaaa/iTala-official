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
  // The durable half: the outbox, its replay, and the reachability signal that
  // decides when to run it. Imported from the app for the same reason as
  // everything above - a suite that reimplemented these would keep passing
  // after the app stopped calling them.
  beginPush, drainableEntries, outboxSnapshot, pruneOutbox, restoreOutbox, unsyncedCount,
  pushPendingEntry, pingServer, fetchLeagueDetail, fetchMemberships, fetchLiveGames,
  isKnownOffline, netStatus, noteReachable, noteUnreachable, probeDelay,
  describeSync, isNetworkFailure,
} = M;

for (const [name, fn] of Object.entries({
  reducer, pushAction, fetchAllState, stampActionIds, enqueuePush,
  beginSnapshot, acceptSnapshot, appliedSnapshotAt,
  recordPending, confirmPending, failPending, pendingCount,
  resetSyncPrimitives,
  beginPush, drainableEntries, outboxSnapshot, pruneOutbox, restoreOutbox, unsyncedCount,
  pushPendingEntry, pingServer,
  isKnownOffline, netStatus, noteReachable, noteUnreachable, probeDelay, describeSync,
  isNetworkFailure,
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
    // On disk before the request leaves, exactly as StoreProvider does it: a
    // write interrupted between the tap and the reply must still be queued on
    // the next launch.
    if (touched.length) this.persist();

    this.syncState = 'saving';
    beginPush(touched);
    const p = enqueuePush(() => pushAction(this.client, action, next)).then(
      outcome => {
        // A RESOLVED push is not by itself a save, and mirroring that is the
        // whole point of this branch. `pushAction` reports a row-level refusal
        // in its resolved value (a rejection would fire the bundle rollback
        // below for writes that are not bundles), so a caller that confirms on
        // resolution alone marks a write the server threw away as saved - which
        // takes it out of the outbox for ever. Same shape as StoreProvider.
        //
        // The `|| []` is deliberate rather than defensive: it makes this branch
        // read a pre-fix `pushAction`, which resolves undefined, as "nothing was
        // refused", so R1/R2 below fail on their assertions rather than on a
        // TypeError.
        const refused = (outcome && outcome.refused) || [];
        if (refused.length > 0) {
          const rejection = new Error(refused.join('; '));
          failPending(touched, rejection);
          // The server ANSWERED. Marking the device offline here would be a
          // second untruth.
          noteReachable();
          this.persist();
          this.syncState = 'error';
          this.pushErrors.push(rejection.message);
          return;
        }
        confirmPending(touched); noteReachable(); this.persist(); this.syncState = 'saved';
      },
      e => {
        failPending(touched, e);
        noteUnreachable(e);
        this.persist();
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
  //
  // Reachability is observed here for the same reason StoreProvider observes it
  // here: a five-table read that never left the device is the clearest evidence
  // of an offline device the app ever gets. And the device AUTOSAVES after
  // hydrating - which is not incidental, it is the step that used to make the
  // data loss permanent, so a suite that skipped it could not reproduce the bug.
  async pull() {
    let snap;
    try {
      snap = await this.snapshot();
      noteReachable();
    } catch (e) {
      noteUnreachable(e);
      return;
    }
    if (snap && snap.remote && snap.remote.leagues) this.applySnapshot(snap);
    this.persist();
  }

  /* ------------------------------------------------------- the outbox ----- */

  // What AsyncStorage would hold right now: the state, and the queue beside it.
  // storage.ts strips `_redo` on the way out, so this does too.
  persist() {
    const clean = {
      ...this.state,
      leagues: this.state.leagues.map(({ _redo, ...l }) => l),
    };
    this.disk = {
      state: JSON.parse(JSON.stringify(clean)),
      outbox: JSON.parse(JSON.stringify(outboxSnapshot())),
    };
  }

  // Send everything the server has not confirmed. Mirrors StoreProvider's
  // drainOutbox, including the two things that make it safe: entries for rows
  // the device no longer has are pruned first, and a transport failure stops
  // the loop rather than burning the rest of the queue against a dead host.
  async drain() {
    const gIds = new Set();
    for (const l of this.state.leagues) {
      for (const g of l.games) gIds.add(g.id);
    }
    pruneOutbox(gIds);

    let sent = 0;
    for (const entry of drainableEntries()) {
      if (isKnownOffline()) break;
      beginPush([entry.token]);
      try {
        await enqueuePush(() => pushPendingEntry(this.client, entry));
        confirmPending([entry.token]);
        noteReachable();
        sent++;
      } catch (e) {
        failPending([entry.token], e);
        this.pushErrors.push(String(e && e.message ? e.message : e));
        if (noteUnreachable(e)) break;
      }
      this.persist();
    }
    this.persist();
    // The pull is what RETIRES the drained entries: an entry leaves the ledger
    // only when a snapshot read after its confirmation actually contains it.
    // Without this the outbox keeps every write it has already sent.
    if (sent > 0) { await this.pull(); this.persist(); }
    return sent;
  }

  // Split out so a test can capture a snapshot at one moment and apply it later,
  // which is what a slow refetch that overlaps an undo actually does. The tick
  // is taken BEFORE the read, exactly as StoreProvider does it: that is what
  // makes "this snapshot predates that confirmation" decidable.
  async snapshot(scope = null) {
    const at = beginSnapshot();
    const remote = await fetchAllState(this.client, scope);
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
    // The scope rides with the snapshot, as it does in StoreProvider: null (or
    // absent) means the snapshot speaks for every league.
    const covered = snap.remote.covered === undefined ? null : snap.remote.covered;
    this.dispatch({ t: 'HYDRATE', state: { leagues }, snapshotAt: snap.at, covered });
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
  // leagueId defaults to lg1, which is what every group before the scoping
  // work used; GROUP U needs a second league, so it may name one.
  points(gameId = 'g1', leagueId = 'lg1') {
    const l = this.league(leagueId);
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

/* ==========================================================================
   GROUP O - offline durability: the stat that survives a closed app
   ==========================================================================

   The reported bug, in the reporter's words: stats entered offline, connection
   restored, a new stat succeeds, the score on screen is right, the app is
   closed and reopened, and the earlier scores are gone.

   Every step of that is reproduced here against the real reducer, the real
   ledger, the real push layer and a server that can lose its connection. O1
   proves the loss is real without the outbox; O2 proves the outbox is what
   stops it. The rest cover the ways a retrying queue can go wrong, of which
   duplicating a stat would be worse than the bug it fixes.
   ========================================================================== */

// The process ends and starts again: the ledger, the push chain and the
// reachability signal all die with it, and the next launch has nothing but what
// reached the disk. `restoreOutbox` is called in the position StoreProvider
// calls it - after loading the saved state, BEFORE any server pull.
function relaunch(device, withOutbox) {
  const disk = device.disk;
  resetSyncPrimitives();
  const D = new Device(device.name, device.server);
  D.state = JSON.parse(JSON.stringify(disk.state));
  D.disk = disk;
  if (withOutbox !== false) restoreOutbox(disk.outbox);
  return D;
}

// Three baskets logged with no connection. Returns the device, mid-outage.
async function threeStatsLoggedOffline() {
  const server = new FakeServer();
  const A = await seed(server);
  A.persist();
  server.offline(true);
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', 'fg3_make', 1));
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', 'fg3_make', 1));
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', 'fg3_make', 1));
  await A.settle();
  return A;
}

async function o1_the_loss_is_real_without_a_durable_queue() {
  const A = await threeStatsLoggedOffline();
  eq('O1.1 the board shows all three baskets', A.points(), 9);
  eq('O1.2 none of them reached the server', A.server.count('events'), 0);
  ok('O1.3 every push reported a transport failure',
     A.pushErrors.length === 3 && A.pushErrors.every(m => /Network request failed/.test(m)));
  eq('O1.4 the device knows it is offline', netStatus(), 'offline');

  // The connection comes back and one more stat goes up, exactly as reported.
  A.server.offline(false);
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', 'fg2_make', 1));
  await A.settle();
  eq('O1.5 the new stat succeeds', A.server.count('events'), 1);
  eq('O1.6 the board still looks right', A.points(), 11);

  // ...and now close the app with the queue thrown away. This is the pre-fix
  // world: the ledger lived in memory only, so a relaunch started with nothing.
  const B = relaunch(A, false);
  eq('O1.7 the saved state still holds them before any pull', B.points(), 11);
  await B.pull();
  eq('O1.8 THE BUG: the boot pull deletes every offline stat', B.points(), 2);
  eq('O1.9 and the autosave writes that over the only durable copy',
     B.disk.state.leagues[0].events.length, 1);
}

async function o2_a_restored_outbox_keeps_the_stats() {
  const A = await threeStatsLoggedOffline();
  A.server.offline(false);
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', 'fg2_make', 1));
  await A.settle();
  eq('O2.1 three writes are still unsent', unsyncedCount(), 3);

  // Close and reopen, this time with the outbox on disk where it belongs.
  const B = relaunch(A);
  eq('O2.2 the outbox came back with three entries', unsyncedCount(), 3);
  await B.pull();
  eq('O2.3 the boot pull no longer deletes them', B.points(), 11);
  eq('O2.4 and the autosave keeps them durable', B.disk.state.leagues[0].events.length, 4);

  // The drain is what finally gets them there.
  const sent = await B.drain();
  eq('O2.5 all three were sent on reconnect', sent, 3);
  eq('O2.6 the server now holds every basket', B.server.count('events'), 4);
  eq('O2.7 nothing is left waiting', unsyncedCount(), 0);
  eq('O2.8 the board is unchanged throughout', B.points(), 11);

  // And the reopen the reporter actually did: everything is simply there.
  const C = relaunch(B);
  await C.pull();
  eq('O2.9 reopening shows the correct synced score', C.points(), 11);
  eq('O2.10 the outbox is empty and stays empty', unsyncedCount(), 0);
}

async function o3_replay_cannot_duplicate_a_stat() {
  const A = await threeStatsLoggedOffline();
  const ids = A.eventIds();

  // The nastiest retry case, and the reason replay upserts rather than inserts:
  // the write DID reach the server and only the reply was lost. The outbox has
  // no way to know that, so it re-sends - and must not double the score.
  const ev = A.league().events.find(e => e.id === ids[0]);
  A.server.rows.events.push({
    id: ev.id, league_id: 'lg1', game_id: ev.gameId, team_id: ev.teamId,
    player_id: ev.playerId, type: ev.type, period: ev.period, ts: ev.ts, note: null,
  });

  A.server.offline(false);
  noteReachable();
  const sent = await A.drain();
  eq('O3.1 every queued write was replayed', sent, 3);
  eq('O3.2 the server holds three rows, not four', A.server.count('events'), 3);
  eq('O3.3 the score did not double', A.points(), 9);

  // Draining again is a no-op: the pull inside the first drain retired them.
  const again = await A.drain();
  eq('O3.4 a second drain sends nothing', again, 0);
  eq('O3.5 and adds no rows', A.server.count('events'), 3);
}

async function o4_a_new_stat_does_not_report_the_old_ones_saved() {
  const A = await threeStatsLoggedOffline();
  A.server.offline(false);
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', 'fg2_make', 1));
  await A.settle();

  // The push state says 'saved', because the LAST write did save. That reading
  // is what made the reported bug invisible, so the summary must not repeat it
  // while three earlier writes are still queued.
  eq('O4.1 the last push did succeed', A.syncState, 'saved');
  const s = describeSync({ enabled: true, net: 'online', pending: unsyncedCount(), writeState: 'saved', lastError: null });
  eq('O4.2 the summary does not claim everything is saved', s.phase, 'syncing');
  ok('O4.3 and it says how much is waiting', /3 changes/.test(s.label), s.label);
}

async function o5_a_refused_write_stays_queued_and_is_retried() {
  const server = new FakeServer();
  const A = await seed(server);
  A.persist();

  // Not a connection failure: the server answered and refused. Such a write is
  // never dropped - it stays queued, and stays visible as a failure.
  const refusal = { message: 'new row violates row-level security policy for table "events"' };
  server.failures['insert:events'] = refusal;
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', 'fg3_make', 1));
  await A.settle();
  eq('O5.1 the write is queued', unsyncedCount(), 1);
  eq('O5.2 a rejection does not mark the device offline', netStatus(), 'online');
  eq('O5.3 the basket is still on the board', A.points(), 3);

  // Retrying while it is still refused keeps it, and counts the attempt.
  server.failures['upsert:events'] = refusal;
  await A.drain();
  eq('O5.4 a refused replay does not discard the write', unsyncedCount(), 1);
  ok('O5.5 the attempt is recorded', outboxSnapshot()[0].attempts >= 1);
  ok('O5.6 and why', /row-level security/.test(outboxSnapshot()[0].lastError || ''));

  // Rights restored: the same entry goes up untouched.
  delete server.failures['insert:events'];
  delete server.failures['upsert:events'];
  const sent = await A.drain();
  eq('O5.7 the retry succeeds once the server accepts it', sent, 1);
  eq('O5.8 the stat is on the server', server.count('events'), 1);
  eq('O5.9 nothing is left waiting', unsyncedCount(), 0);
}

async function o6_repeated_transitions_lose_nothing() {
  const server = new FakeServer();
  const A = await seed(server);
  A.persist();

  // Five out, five in, a basket on each side of every transition.
  for (let i = 0; i < 5; i++) {
    server.offline(true);
    A.dispatch(score('lg1', 'g1', 'tH', 'p1', 'fg2_make', 1));
    await A.settle();
    server.offline(false);
    noteReachable();
    A.dispatch(score('lg1', 'g1', 'tH', 'p1', 'ft_make', 1));
    await A.settle();
    await A.drain();
  }
  eq('O6.1 every basket is on the board', A.points(), 15);
  eq('O6.2 every basket reached the server', server.count('events'), 10);
  eq('O6.3 nothing is left waiting', unsyncedCount(), 0);

  // And a relaunch agrees with both.
  const B = relaunch(A);
  await B.pull();
  eq('O6.4 reopening shows the same score', B.points(), 15);
}

async function o7_a_drain_stops_when_the_connection_dies_again() {
  const A = await threeStatsLoggedOffline();
  A.server.offline(false);
  noteReachable();

  // The connection dies again in the middle of the queue: the second replay
  // fails at the transport. The rest must stay queued rather than being burned
  // against a host that is not there.
  const realFrom = A.client.from.bind(A.client);
  let seen = 0;
  A.client.from = table => {
    const t = realFrom(table);
    if (table !== 'events') return t;
    return Object.assign({}, t, {
      upsert: payload => {
        if (++seen === 2) A.server.offline(true);
        return t.upsert(payload);
      },
    });
  };

  const sent = await A.drain();
  eq('O7.1 only the writes that could land did', sent, 1);
  eq('O7.2 the rest are still queued', unsyncedCount(), 2);
  eq('O7.3 nothing was thrown away', A.points(), 9);
  eq('O7.4 and the device knows it is offline again', netStatus(), 'offline');

  // Restore everything and finish the job.
  A.client.from = realFrom;
  A.server.offline(false);
  noteReachable();
  await A.drain();
  eq('O7.5 the remainder syncs on the next reconnect', A.server.count('events'), 3);
  eq('O7.6 nothing is left waiting', unsyncedCount(), 0);
}

async function o8_an_offline_undo_is_replayed_as_a_delete() {
  const server = new FakeServer();
  const A = await seed(server);
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', 'fg3_make', 1));
  await A.settle();
  A.persist();
  eq('O8.1 the basket is on the server', server.count('events'), 1);

  server.offline(true);
  A.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg1', gameId: 'g1' });
  await A.settle();
  eq('O8.2 the undo is local only for now', A.points(), 0);
  eq('O8.3 the server still has the row', server.count('events'), 1);
  eq('O8.4 the undo is queued', unsyncedCount(), 1);

  // The dangerous moment: a pull while the delete is unsent must not hand the
  // basket back. The restored-and-unconfirmed entry is what prevents it.
  const B = relaunch(A);
  B.server.offline(false);
  await B.pull();
  eq('O8.5 a pull does not resurrect the undone basket', B.points(), 0);

  noteReachable();
  await B.drain();
  eq('O8.6 the delete reaches the server on reconnect', server.count('events'), 0);
  eq('O8.7 nothing is left waiting', unsyncedCount(), 0);
}

async function o9_a_write_for_a_deleted_game_is_never_replayed() {
  const server = new FakeServer();
  const A = await seed(server);
  A.persist();
  server.offline(true);

  // A lineup written offline, then the game deleted. The delete leaves no entry
  // of its own - there is no row left to mirror - so without pruning, the older
  // write would put the game back on the server on reconnect.
  A.dispatch({ t: 'SET_LINEUP', leagueId: 'lg1', gameId: 'g1', side: 'home', playerIds: ['p1'] });
  await A.settle();
  ok('O9.1 the lineup write is queued', unsyncedCount() >= 1);
  A.dispatch({ t: 'DELETE_GAME', leagueId: 'lg1', gameId: 'g1' });
  await A.settle();
  ok('O9.2 the game is gone locally', !A.game('g1'));

  server.offline(false);
  noteReachable();
  await A.drain();
  ok('O9.3 no queued write survives for the deleted game',
     !outboxSnapshot().some(e => e.gameId === 'g1'));
}

async function o10_connectivity_is_observed_not_assumed() {
  eq('O10.1 nothing has been tried yet', netStatus(), 'unknown');
  ok('O10.2 and unknown is not treated as offline', !isKnownOffline());

  noteUnreachable(new TypeError('Network request failed'));
  eq('O10.3 a transport failure means offline', netStatus(), 'offline');
  ok('O10.4 which IS treated as offline', isKnownOffline());

  // A server that answers with a refusal is a server that answered.
  noteUnreachable(new Error('new row violates row-level security policy'));
  eq('O10.5 a rejection is not a connection problem', netStatus(), 'online');

  noteUnreachable(new TypeError('Network request failed'));
  noteReachable();
  eq('O10.6 a successful round trip clears it', netStatus(), 'online');

  ok('O10.7 the probe backs off', probeDelay(0) < probeDelay(3));
  ok('O10.8 and is capped', probeDelay(99) === probeDelay(4) && probeDelay(99) <= 30000);
}

async function o11_the_summary_says_what_is_true() {
  const at = (net, pending, writeState, lastError) =>
    describeSync({ enabled: true, net, pending, writeState, lastError: lastError || null });

  eq('O11.1 connected and settled', at('online', 0, 'idle').phase, 'synced');
  eq('O11.2 connected and sending', at('online', 0, 'saving').phase, 'syncing');
  eq('O11.3 offline with nothing waiting', at('offline', 0, 'idle').phase, 'offline');
  eq('O11.4 offline with changes waiting', at('offline', 3, 'idle').phase, 'offline-pending');
  eq('O11.5 connected but refused', at('online', 2, 'error', 'No rights').phase, 'failed');

  // The two readings that used to lie.
  eq('O11.6 a build with no server is never "Connected"',
     describeSync({ enabled: false, net: 'online', pending: 0, writeState: 'idle', lastError: null }).phase,
     'local-only');
  eq('O11.7 offline is never "Connected", whatever the last write did',
     at('offline', 0, 'saved').phase, 'offline');
  ok('O11.8 a waiting queue outranks a saved last write',
     at('online', 4, 'saved').phase === 'syncing');

  // Every state has to fit the chip beside Exit, and carry a real sentence.
  const shapes = [at('online', 0, 'idle'), at('offline', 12, 'idle'), at('online', 7, 'error', 'x'), at('online', 0, 'saving')];
  for (const s of shapes) {
    ok('O11.9 the chip label is short enough: ' + s.short, s.short.length <= 16, s.short);
    ok('O11.10 every state has a detail sentence: ' + s.phase, s.detail.length > 20);
  }
}

async function o12_a_pull_alone_clears_a_stale_not_saved() {
  // "When connectivity is restored and the user successfully refreshes, the
  // stale Not saved state must disappear." It could not: the badge read
  // syncState, which only a successful PUSH ever reset, and a refresh is a pull.
  const A = await threeStatsLoggedOffline();
  eq('O12.1 the badge is in its error state', A.syncState, 'error');
  const before = describeSync({ enabled: true, net: netStatus(), pending: unsyncedCount(), writeState: A.syncState, lastError: 'x' });
  eq('O12.2 and reads as offline with changes waiting', before.phase, 'offline-pending');

  A.server.offline(false);
  noteReachable();
  await A.drain();
  const after = describeSync({ enabled: true, net: netStatus(), pending: unsyncedCount(), writeState: 'saved', lastError: null });
  eq('O12.3 a successful sync clears it', after.phase, 'saved');
  eq('O12.4 because there is genuinely nothing waiting', unsyncedCount(), 0);
}

async function o13_a_malformed_outbox_never_breaks_a_launch() {
  // Storage is not a trusted input: an older build, a truncated write, a device
  // whose disk lied. None of it may stop the app starting, and none of it may
  // become a push that can only fail.
  const bad = [
    null, undefined, 42, 'nope',
    { token: 'add:x' },
    { token: 'add:x2', leagueId: 'lg1', kind: 'event', op: 'add' },
    { token: 'game:g', leagueId: 'lg1', kind: 'game' },
    { token: 'add:ok', leagueId: 'lg1', kind: 'event', op: 'add', eventId: 'ok',
      event: { id: 'ok', gameId: 'g1', teamId: 'tH', playerId: 'p1', type: 'fg3_make', period: 1, ts: 1 } },
  ];
  const restored = restoreOutbox(bad);
  eq('O13.1 only the well-formed entry is restored', restored, 1);
  eq('O13.2 and it is the one that can actually be pushed', unsyncedCount(), 1);
}


/* ==========================================================================
   GROUP O2 - the failure the emulator was hiding
   ==========================================================================

   Everything above this point ran against a harness that THREW when the
   connection was gone. The installed @supabase/postgrest-js does not throw: it
   catches the fetch rejection and RESOLVES with { data: null, error, status: 0 }.
   Verified against this repository's own node_modules - a select and an upsert
   against an unreachable host both come back that way, with an error message of
   'TypeError: fetch failed'.

   That one difference is why this suite was green on code that could not work.
   `check` inspected .error, logged it and returned, so `pushAction` resolved,
   the ledger was told the server had the write, and the entry was confirmed -
   never queued, never persisted, never retried. Every action that pushes
   through `check` was affected: SET_LINEUP, SET_LINEUPS, SUBSTITUTE,
   SET_ATTENDANCE, SET_GAME_STATUS, SET_PERIOD and CREATE_GAME.

   `server.offline()` now defaults to the resolving shape, so the groups above
   run against it too. O19 keeps the rejecting one honest.
   ========================================================================== */

async function o14_an_offline_game_write_is_queued_not_confirmed() {
  const server = new FakeServer();
  const A = await seed(server);
  A.persist();
  server.offline(true);

  // A substitution: the scorekeeper's five changes on the board, and the push
  // for it resolves with an error nobody looked at.
  A.dispatch({ t: 'SET_LINEUP', leagueId: 'lg1', gameId: 'g1', side: 'home', playerIds: ['p1'] });
  await A.settle();
  eq('O14.1 the lineup is on the board', A.game().homeOnCourt, ['p1']);
  ok('O14.2 the push reported the failure instead of a save',
     A.pushErrors.some(m => /Network request failed/.test(m)), A.pushErrors.join(' | '));
  eq('O14.3 so the write is QUEUED, not confirmed', unsyncedCount(), 1);
  ok('O14.4 and it reached the disk, where a relaunch can find it',
     A.disk.outbox.some(e => e.kind === 'game' && e.gameId === 'g1'));
  eq('O14.5 the device knows it is offline', netStatus(), 'offline');

  // The period and the status push through the same helper. One entry holds
  // the latest row, because the push writes the whole row.
  A.dispatch({ t: 'SET_PERIOD', leagueId: 'lg1', gameId: 'g1', period: 3 });
  await A.settle();
  A.dispatch({ t: 'SET_GAME_STATUS', leagueId: 'lg1', gameId: 'g1', status: 'final' });
  await A.settle();
  eq('O14.6 consecutive edits supersede each other in one entry', unsyncedCount(), 1);

  // The reported ending: reconnect, and the first snapshot used to win.
  server.offline(false);
  noteReachable();
  await A.pull();
  eq('O14.7 the pull does not revert the period', A.game().period, 3);
  eq('O14.8 nor the status', A.game().status, 'final');
  eq('O14.9 nor the on-court five', A.game().homeOnCourt, ['p1']);

  const sent = await A.drain();
  eq('O14.10 the queued row is replayed on reconnect', sent, 1);
  eq('O14.11 the server holds the period', server.find('games', 'g1').period, 3);
  eq('O14.12 the status', server.find('games', 'g1').status, 'final');
  eq('O14.13 and the five', server.find('games', 'g1').home_on_court, ['p1']);
  eq('O14.14 nothing is left waiting', unsyncedCount(), 0);

  // And it survives being closed, which is the half the ledger alone never had.
  const B = relaunch(A);
  await B.pull();
  eq('O14.15 reopening agrees', B.game().homeOnCourt, ['p1']);
}

async function o15_a_substitution_survives_a_relaunch() {
  const server = new FakeServer();
  const A = await seed(server);
  A.dispatch({ t: 'SET_LINEUPS', leagueId: 'lg1', gameId: 'g1', home: ['p1'], away: ['p2'] });
  await A.settle();
  A.persist();
  eq('O15.1 the server has the starting five', server.find('games', 'g1').home_on_court, ['p1']);

  // Add a second home player to substitute in.
  A.dispatch({ t: 'ADD_PLAYER', leagueId: 'lg1', teamId: 'tH', name: 'Juan B', number: '9', id: 'p3' });
  await A.settle();
  A.persist();

  server.offline(true);
  A.dispatch({ t: 'SUBSTITUTE', leagueId: 'lg1', gameId: 'g1', side: 'home', outId: 'p1', inId: 'p3' });
  await A.settle();
  eq('O15.2 the substitution is on the board', A.game().homeOnCourt, ['p3']);
  eq('O15.3 and queued rather than reported saved', unsyncedCount(), 1);

  // Close the app mid-outage. This is where an unqueued substitution was lost:
  // the boot pull hydrated the server's older row and the autosave kept it.
  const B = relaunch(A);
  B.server.offline(false);
  await B.pull();
  eq('O15.4 the boot pull does not put the old five back', B.game().homeOnCourt, ['p3']);
  eq('O15.5 and the durable copy agrees', B.disk.state.leagues[0].games[0].homeOnCourt, ['p3']);

  noteReachable();
  await B.drain();
  eq('O15.6 the substitution reaches the server on reconnect',
     server.find('games', 'g1').home_on_court, ['p3']);
  eq('O15.7 nothing is left waiting', unsyncedCount(), 0);
}

async function o16_the_probe_reads_the_response_not_a_throw() {
  const server = new FakeServer();
  const sb = makeClient(server);
  eq('O16.1 a server that answers is reachable', await pingServer(sb), true);

  // The shape the installed client actually produces.
  server.offline(true);
  eq('O16.2 a RESOLVED transport failure is not reachable', await pingServer(sb), false);

  // And the rejecting one, which is all this harness used to model.
  server.offline(false);
  server.offline(true, 'throw');
  eq('O16.3 a rejected transport failure is not reachable either', await pingServer(sb), false);

  // A refusal is a server that answered, and the probe asks nothing about data.
  server.offline(false);
  server.failures['select:leagues'] = { message: 'permission denied for table leagues' };
  eq('O16.4 a row-level refusal still proves the host answered', await pingServer(sb), true);
}

async function o17_a_dead_read_is_not_a_bad_read() {
  const server = new FakeServer();
  const A = await seed(server);
  A.persist();

  server.offline(true);
  let thrown = null;
  try { await fetchAllState(A.client); } catch (e) { thrown = e && e.message; }
  ok('O17.1 a read that never left the device REJECTS', thrown !== null, String(thrown));
  ok('O17.2 in words the connectivity layer classifies as offline',
     isNetworkFailure(thrown || ''), String(thrown));

  // A row-level problem still resolves null. The host answered; the caller's
  // existing 'no snapshot this time' handling is the right response.
  server.offline(false);
  server.failures['select:leagues'] = { message: 'permission denied for table leagues' };
  eq('O17.3 a row-level read problem still resolves', await fetchAllState(A.client), null);
  delete server.failures['select:leagues'];

  // And the pull path draws the right conclusion from each.
  noteReachable();
  eq('O17.4 the device believes it is online', netStatus(), 'online');
  server.offline(true);
  await A.pull();
  eq('O17.5 a failed five-table read means offline', netStatus(), 'offline');
  ok('O17.6 which is what makes pull-to-refresh say so', isKnownOffline());
  eq('O17.7 and nothing local was disturbed', A.league().games.length, 1);
}

async function o18_one_transport_two_spellings() {
  // React Native and Node word the same failure differently. Only the first was
  // matched, so every offline check run on a laptop classified a dead request
  // as a row-level rejection - and marked the device online.
  ok('O18.1 React Native', isNetworkFailure('TypeError: Network request failed'));
  ok('O18.2 Node and undici', isNetworkFailure('TypeError: fetch failed'));
  ok('O18.3 the browser', isNetworkFailure('TypeError: Failed to fetch'));
  ok('O18.4 but a refusal is still a refusal',
     !isNetworkFailure('new row violates row-level security policy for table "events"'));
  ok('O18.5 and so is a duplicate key',
     !isNetworkFailure('duplicate key value violates unique constraint "events_pkey"'));

  noteUnreachable(new TypeError('fetch failed'));
  eq('O18.6 the reachability signal agrees with both', netStatus(), 'offline');
}

async function o19_both_transports_leave_the_same_ledger() {
  // The rejecting mode is kept, and this is what it is for: whichever way the
  // client reports a lost connection, the ledger, the outbox and the
  // reachability signal must end up in the same place.
  const seen = [];
  for (const mode of ['resolve', 'throw']) {
    resetSyncPrimitives();
    const server = new FakeServer();
    const A = await seed(server);
    A.persist();
    server.offline(true, mode);
    A.dispatch(score('lg1', 'g1', 'tH', 'p1', 'fg3_make', 1));
    A.dispatch({ t: 'SET_LINEUP', leagueId: 'lg1', gameId: 'g1', side: 'home', playerIds: ['p1'] });
    await A.settle();
    seen.push({
      mode,
      unsynced: unsyncedCount(),
      net: netStatus(),
      points: A.points(),
      kinds: outboxSnapshot().map(e => e.kind).sort().join(','),
      onCourt: A.game().homeOnCourt.join(','),
    });
  }
  eq('O19.1 the resolving transport queues the stat AND the lineup', seen[0].unsynced, 2);
  eq('O19.2 both kinds are in the outbox', seen[0].kinds, 'event,game');
  eq('O19.3 the rejecting transport agrees, field for field',
     { ...seen[1], mode: 'resolve' }, seen[0]);
}

/* ==========================================================================
   GROUP R - the writes that resolved having written nothing
   ==========================================================================

   Group O2 covered the request that never ARRIVED. This one covers the two
   remaining ways a push resolved while the server held nothing, both reachable
   on a perfectly good connection.

   R1  the server ANSWERED and refused the row. `check` logged it and returned,
       so the push resolved, `confirmPending` retired the token out of the
       outbox filter, and the next snapshot handed back the stale row. The badge
       read "Everything on this device is saved to the server".

   R2  CREATE_GAME names its row `id`, not `gameId`, so the ledger minted no
       token for it at all. A game created offline had no entry, no outbox row
       and no protection, and the next pull deleted it.
   ========================================================================== */

// A refusal, not an outage: the response carries an error and NO status, so
// nothing in the transport classifier can mistake it for a lost connection.
const REFUSED_GAME = { message: 'new row violates row-level security policy for table "games"' };

async function r1_a_refused_game_write_is_queued_not_confirmed() {
  const server = new FakeServer();
  const A = await seed(server);
  // Retire the seed's own writes so every count below is about this test.
  A.applySnapshot(await A.snapshot());
  eq('R1.1 a clean ledger to start from', pendingCount(), 0);
  eq('R1.2 and the device believes it is online', netStatus(), 'online');

  server.failures['upsert:games'] = REFUSED_GAME;
  A.dispatch({ t: 'SET_LINEUP', leagueId: 'lg1', gameId: 'g1', side: 'home', playerIds: ['p1'] });
  await A.settle();

  eq('R1.3 the five is on the board', A.game().homeOnCourt, ['p1']);
  eq('R1.4 and the server does not have it', server.find('games', 'g1').home_on_court, []);
  ok('R1.5 the push reported the refusal instead of a save',
     A.pushErrors.some(m => /row-level security/.test(m)), A.pushErrors.join(' | '));
  eq('R1.6 so the write is QUEUED, not confirmed', unsyncedCount(), 1);
  ok('R1.7 and it reached the disk, where a relaunch can find it',
     A.disk.outbox.some(e => e.kind === 'game' && e.gameId === 'g1'),
     JSON.stringify(A.disk.outbox));
  eq('R1.8 the device did not report it saved', A.syncState, 'error');
  // The refusal is not an outage, and saying it is would send the probe loop
  // after a connection that is answering perfectly well.
  eq('R1.9 the device is still online', netStatus(), 'online');

  // What the person is actually told. Red and counted, not green.
  const chip = describeSync({
    enabled: true, net: netStatus(), pending: unsyncedCount(),
    writeState: A.syncState === 'error' ? 'error' : 'saved', lastError: null,
  });
  eq('R1.10 the chip is the failed state', chip.phase, 'failed');
  eq('R1.11 in the bad tone', chip.tone, 'bad');
  ok('R1.12 and it does NOT claim everything is saved',
     !/Everything on this device is saved/.test(chip.detail), chip.detail);

  // The reported ending: the next snapshot used to win.
  A.applySnapshot(await A.snapshot());
  eq('R1.13 the pull does not revert the five', A.game().homeOnCourt, ['p1']);
  ok('R1.14 nor does the autosave destroy the durable copy',
     A.disk.state.leagues[0].games[0].homeOnCourt.join(',') === 'p1',
     JSON.stringify(A.disk.state.leagues[0].games[0].homeOnCourt));
  eq('R1.15 the entry is still queued after the pull', unsyncedCount(), 1);

  // And the recovery path, which is what makes a red chip acceptable: the
  // rights come back, the drain replays the whole row, and it clears.
  delete server.failures['upsert:games'];
  const sent = await A.drain();
  eq('R1.16 the queued row is replayed once the refusal lifts', sent, 1);
  eq('R1.17 and the server now holds it', server.find('games', 'g1').home_on_court, ['p1']);
  eq('R1.18 nothing is left waiting', unsyncedCount(), 0);
}

// The stat half of the same defect. ADD_EVENT is critical, so its INSERT
// rethrows - but the game row it also pushes when a foul benches a player goes
// through `check`, and so did every other non-critical write. This pins the
// general rule rather than the one action: a refusal is reported, whatever the
// caller then does with it.
async function r2_a_refusal_is_reported_by_the_push_itself() {
  const server = new FakeServer();
  const A = await seed(server);
  A.applySnapshot(await A.snapshot());

  server.failures['upsert:games'] = REFUSED_GAME;
  const outcome = await pushAction(
    A.client,
    { t: 'SET_PERIOD', leagueId: 'lg1', gameId: 'g1', period: 3 },
    A.state,
  );
  // Read defensively so a push that reports nothing fails on the assertion
  // rather than on a TypeError - the pre-fix shape resolves undefined.
  const said = (outcome && outcome.refused) || [];
  ok('R2.1 the push RESOLVES rather than rejecting', !!outcome, String(outcome));
  eq('R2.2 and names the write the server refused', said.length, 1);
  ok('R2.3 with the label and the server words attached',
     /UPSERT_games/.test(String(said[0])) && /row-level security/.test(String(said[0])),
     String(said[0]));

  // A clean write reports nothing, which is the other half of the contract.
  delete server.failures['upsert:games'];
  const clean = await pushAction(
    A.client,
    { t: 'SET_PERIOD', leagueId: 'lg1', gameId: 'g1', period: 3 },
    A.state,
  );
  eq('R2.4 an accepted write refuses nothing', (clean && clean.refused) || 'no outcome at all', []);

  // And a bundle write still REJECTS, because its local half has to roll back.
  server.failures['rpc:rec_setup_game'] = { message: 'Scorekeeper access required.' };
  let threw = null;
  try {
    await pushAction(A.client, {
      t: 'REC_SETUP_GAME', leagueId: 'lg1', gameId: 'gRec', location: '',
      teams: [{ id: 'tH', name: 'Warriors', players: [] }],
    }, A.state);
  } catch (e) { threw = (e && e.message) || String(e); }
  ok('R2.5 an all-or-nothing bundle still rejects, so its rollback still fires',
     !!threw && /Scorekeeper access required/.test(threw), String(threw));
}

async function r3_a_game_created_offline_is_queued_and_survives_the_pull() {
  const server = new FakeServer();
  const A = await seed(server);
  A.applySnapshot(await A.snapshot());
  eq('R3.1 a clean ledger to start from', pendingCount(), 0);

  server.offline(true);
  A.dispatch({ t: 'CREATE_GAME', id: 'g9', leagueId: 'lg1', homeTeamId: 'tH', awayTeamId: 'tA' });
  await A.settle();

  ok('R3.2 the game is in the list', !!A.game('g9'));
  eq('R3.3 the server never got it', server.has('games', 'g9'), false);
  eq('R3.4 so it is QUEUED rather than reported saved', unsyncedCount(), 1);
  ok('R3.5 and it reached the disk, where a relaunch can find it',
     A.disk.outbox.some(e => e.kind === 'game' && e.gameId === 'g9'),
     JSON.stringify(A.disk.outbox));
  eq('R3.6 the device knows it is offline', netStatus(), 'offline');

  // The reported ending: the next pull deleted the game and the autosave made
  // it permanent.
  server.offline(false);
  noteReachable();
  await A.pull();
  ok('R3.7 the pull does not delete the game', !!A.game('g9'));
  ok('R3.8 nor does the autosave destroy the durable copy',
     A.disk.state.leagues[0].games.some(g => g.id === 'g9'),
     A.disk.state.leagues[0].games.map(g => g.id).join(','));

  const sent = await A.drain();
  eq('R3.9 the queued game reaches the server on reconnect', sent, 1);
  ok('R3.10 and the row is really there', server.has('games', 'g9'));
  eq('R3.11 nothing is left waiting', unsyncedCount(), 0);

  // The force-quit, which is where it used to become unrecoverable.
  const B = relaunch(A);
  await B.pull();
  ok('R3.12 reopening still has the game', !!B.game('g9'));
}

// A created game that is then deleted must NOT be put back by the queued
// create. `pruneOutbox` already covers this for every other game write; the new
// entry has to be covered by the same rule rather than becoming an exception.
async function r4_a_created_game_deleted_before_it_syncs_is_not_resurrected() {
  const server = new FakeServer();
  const A = await seed(server);
  A.applySnapshot(await A.snapshot());

  server.offline(true);
  A.dispatch({ t: 'CREATE_GAME', id: 'g9', leagueId: 'lg1', homeTeamId: 'tH', awayTeamId: 'tA' });
  await A.settle();
  eq('R4.1 the create is queued', unsyncedCount(), 1);

  A.dispatch({ t: 'DELETE_GAME', leagueId: 'lg1', gameId: 'g9' });
  await A.settle();
  ok('R4.2 the game is gone locally', !A.game('g9'));

  server.offline(false);
  noteReachable();
  const sent = await A.drain();
  eq('R4.3 the drain sends nothing for a game the device no longer has', sent, 0);
  eq('R4.4 and the queue is empty', unsyncedCount(), 0);
  eq('R4.5 the server was never asked to create it', server.has('games', 'g9'), false);
}

/* ==========================================================================
   GROUP T - the read that was not the whole table
   ==========================================================================

   Nothing offline here, nothing refused, nothing racing. Every write in this
   group is inserted, acknowledged and confirmed. The only thing wrong is that
   the SERVER will not return the whole table in one reply and does not say so.

   PostgREST caps a response at db-max-rows (1000 on a default Supabase
   project) and reports an ordinary success carrying a short array. fetchAllState
   had no pagination, so past that many rows a pull returned a PREFIX - and
   because the events query is ordered ascending, the rows it dropped were the
   newest ones. A snapshot is applied wholesale, so the game being scored was
   deleted locally as though another device had removed it, and the autosave
   wrote that over the last durable copy of it.

   T1 reproduces the loss end to end. T2 and T3 pin the properties of the fix
   that a naive version would get wrong: paging has to be cap-agnostic (a
   project whose cap is BELOW the client's page size must not look like a table
   that ends early), and a read that cannot be completed has to fail rather than
   hand back a prefix.
   ========================================================================== */

// Four baskets in an earlier game and three in tonight's, with explicit ids and
// timestamps so which rows are "newest" is decided here rather than by the
// clock. Everything is on the server before the cap is applied.
async function seedTwoGames(server) {
  const A = await seed(server);
  A.dispatch({ t: 'CREATE_GAME', id: 'g0', leagueId: 'lg1', homeTeamId: 'tH', awayTeamId: 'tA' });
  for (let i = 0; i < 4; i++) {
    A.dispatch({ ...score('lg1', 'g0', 'tH', 'p1', 'fg2_make', 1), id: 'old' + i, ts: 1000 + i });
  }
  for (let i = 0; i < 3; i++) {
    A.dispatch({ ...score('lg1', 'g1', 'tH', 'p1', 'fg3_make', 1), id: 'new' + i, ts: 5000 + i });
  }
  await A.settle();
  return A;
}

async function t1_a_capped_reply_is_not_the_whole_table() {
  const server = new FakeServer();
  const A = await seedTwoGames(server);
  eq('T1.1 every basket reached the server', server.count('events'), 7);
  eq('T1.2 tonight is 9 on the device', A.points('g1'), 9);
  eq('T1.3 nothing is queued and nothing failed', unsyncedCount(), 0);
  eq('T1.4 no push reported a failure', A.pushErrors, []);

  // The server will not return more than four event rows per reply. It says
  // nothing about it: no error, no status, just a short array.
  server.maxRows = 4;

  const snap = await fetchAllState(A.client);
  const lg = snap.leagues.find(l => l.id === 'lg1');
  eq('T1.5 the read still returns every event', lg.events.length, 7);
  ok('T1.6 including the newest three', ['new0', 'new1', 'new2'].every(id => lg.events.some(e => e.id === id)),
     lg.events.map(e => e.id).join(','));

  // And the whole point: hydrating that snapshot must not delete tonight.
  const B = new Device('B', server);
  B.state = JSON.parse(JSON.stringify(A.state));
  await B.pull();
  eq('T1.7 the earlier game survives the pull', B.points('g0'), 8);
  eq('T1.8 tonight survives the pull', B.points('g1'), 9);
}

async function t2_paging_does_not_assume_the_servers_cap() {
  const server = new FakeServer();
  const A = await seedTwoGames(server);

  // A cap of one row per reply is the adversarial case for any client that
  // pages by its OWN page size and stops on a short page: every reply is short,
  // so such a client would read exactly one event and call it the table.
  server.maxRows = 1;
  const snap = await fetchAllState(A.client);
  const lg = snap.leagues.find(l => l.id === 'lg1');
  eq('T2.1 a one-row cap still yields all seven events', lg.events.length, 7);
  eq('T2.2 and both teams', lg.teams.length, 2);
  eq('T2.3 and both games', lg.games.length, 2);
  eq('T2.4 and both players', lg.players.length, 2);

  // The league read is capped too, so the loop has to page the table it takes
  // its own iteration order from.
  const server2 = new FakeServer();
  const C = await seed(server2);
  C.dispatch({ t: 'ADD_LEAGUE', id: 'lg2', name: 'Second', season: 'S1' });
  await C.settle();
  server2.maxRows = 1;
  const snap2 = await fetchAllState(C.client);
  eq('T2.5 both leagues come back under a one-row cap', snap2.leagues.length, 2);
}

async function t3_an_unfinishable_read_fails_rather_than_truncating() {
  const server = new FakeServer();
  const A = await seedTwoGames(server);

  // A server that answers with rows but never advances the cursor: every reply
  // carries the same first row whatever id it was asked to read past. A client
  // that trusted the walk to terminate would loop for ever; one that gave up
  // quietly would hand back a prefix, which is the bug. It has to be an error.
  const client = makeClient(server);
  const realFrom = client.from.bind(client);
  client.from = (table) => {
    const t = realFrom(table);
    if (table !== 'events') return t;
    return {
      ...t,
      select: (cols, opts) => {
        void t.select(cols, opts);
        const stuck = {
          order: () => stuck,
          limit: () => stuck,
          gt: () => stuck,
          range: () => stuck,
          then: (res, rej) => Promise.resolve({
            data: server.rows.events.slice(0, 1).map(r => ({ ...r })), error: null, status: 200,
          }).then(res, rej),
          catch: (rej) => Promise.resolve({ data: [], error: null }).catch(rej),
        };
        return stuck;
      },
    };
  };

  let threw = null;
  let out;
  try { out = await fetchAllState(client); } catch (e) { threw = e; }
  ok('T3.1 an unfinishable read does not resolve as a snapshot', out === null || threw !== null,
     JSON.stringify(out && out.leagues && out.leagues.length));
  ok('T3.2 and it never returns a prefix of the events',
     !(out && out.leagues && out.leagues.some(l => l.events.length > 0 && l.events.length < 7)),
     JSON.stringify(out && out.leagues && out.leagues.map(l => l.events.length)));

  // A device holding the full game is untouched by it.
  const B = new Device('B', server);
  B.state = JSON.parse(JSON.stringify(A.state));
  B.client = client;
  await B.pull();
  eq('T3.3 the device keeps tonight', B.points('g1'), 9);
}

/* THE RACES OFFSET PAGING LOST, AND KEYSET DOES NOT.

   Every case below is a read taken while somebody else writes. They are the
   reason the pull walks id instead of asking for OFFSET windows: OFFSET is
   defined against a result set that is moving, so a delete behind the cursor
   makes the next window step over a surviving row - and the exact count shrinks
   by the same one, so the completeness check cannot see it. Undo issues a real
   DELETE, and because the read is global, the undo does not even have to be in
   your league. All of these were demonstrated against the offset version before
   it was replaced. */

// A page of two, so paging is genuinely multi-request, with an Undo landing
// between the first reply and the second. `beforeRead` is used rather than a
// wrapped builder because a wrapped builder does not survive .order()/.limit().
async function pagedServerWithDeleteMidRead(deleteId) {
  const server = new FakeServer();
  const A = await seedTwoGames(server);
  server.maxRows = 2;
  server.readCounts = {};
  server.beforeRead = (table, n) => {
    // Somebody, anywhere, taps Undo once we are past the first page of events.
    if (table === 'events' && n === 1) {
      server.rows.events = server.rows.events.filter(r => r.id !== deleteId);
    }
  };
  return { server, A, client: A.client };
}

async function t6_a_delete_mid_read_cannot_skip_a_surviving_row() {
  // Delete one of the OLD events: a row the first page already returned, which
  // is what shifts every later row down one offset.
  const { server, client } = await pagedServerWithDeleteMidRead('old0');
  const snap = await fetchAllState(client);
  const surviving = server.rows.events.map(r => r.id).sort();

  ok('T6.1 the read either completes or refuses, never half-completes',
     snap === null || snap.leagues !== undefined, JSON.stringify(snap));
  if (snap !== null) {
    const got = snap.leagues.flatMap(l => l.events.map(e => e.id)).sort();
    // Whether the deleted row is still in hand depends on when it went, and
    // either answer is defensible. What must never happen is a row that STILL
    // EXISTS going missing, or any row arriving twice - one deletes a stat, the
    // other doubles a score.
    eq('T6.2 no surviving event is skipped', surviving.filter(id => !got.includes(id)), []);
    eq('T6.3 and no event is duplicated', got.length, new Set(got).size);
  }
}

async function t7_a_delete_mid_read_does_not_cost_the_game_on_relaunch() {
  // The same race, ending the way the reporter's did: a relaunch with an empty
  // ledger, where nothing local is pinned and the snapshot is believed in full.
  // The consequence a running device is spared - it still has the row in the
  // ledger - is the one a restarted device takes permanently, because the boot
  // autosave writes whatever the snapshot said over the last durable copy.
  const { server, A } = await pagedServerWithDeleteMidRead('old0');
  A.persist();
  const B = relaunch(A);
  server.readCounts = {};
  eq('T7.1 the relaunch starts from disk with every event intact', B.league().events.length, 7);
  eq('T7.2 and with an empty ledger, as a new process has', pendingCount(), 0);

  await B.pull();
  const surviving = server.rows.events.map(r => r.id).sort();
  const onBoard = B.league().events.map(e => e.id);
  const onDisk = B.disk.state.leagues.find(l => l.id === 'lg1').events.map(e => e.id);

  // Every row the server still holds has to be on the board AND on the disk.
  // The pre-keyset read stepped over one, and this is where that becomes
  // permanent: absent from the snapshot, absent from state, absent from disk.
  eq('T7.3 no surviving event is missing from the board',
     surviving.filter(id => !onBoard.includes(id)), []);
  eq('T7.4 and none is missing from the durable copy',
     surviving.filter(id => !onDisk.includes(id)), []);
  eq('T7.5 tonight is still nine points', B.points('g1'), 9);
  eq('T7.6 and the durable copy agrees', diskPoints(B, 'g1'), 9);
}

async function t8_only_an_empty_page_proves_the_walk_finished() {
  // The offset version took the count from the NEWEST page and treated an empty
  // batch as end-of-table unconditionally, so a page answering
  // { data: [], count: 0 } made it accept 1000 of 2500 rows as the whole table.
  // This repo documents that exact reply shape at StoreProvider.tsx - an RLS
  // read taken while the access token is mid-refresh. Keyset keeps no count to
  // be fooled about; what must never happen is a SHORT page read as the end.
  const server = new FakeServer();
  await seedTwoGames(server);
  server.maxRows = 1; // every page is short; none is empty until the walk ends
  const snap = await fetchAllState(makeClient(server));
  ok('T8.1 a short page is not mistaken for the end', snap !== null, 'the snapshot was refused');
  const lg = snap.leagues.find(l => l.id === 'lg1');
  eq('T8.2 all seven events came back, one row per reply', lg.events.length, 7);
  eq('T8.3 and in canonical (ts, id) order', lg.events.map(e => e.id),
     ['old0', 'old1', 'old2', 'old3', 'new0', 'new1', 'new2']);
}

/* What the saved AppState on disk says the score is. `points()` reads the
   RUNNING copy; this reads the only copy that survives a force-quit, and the
   one the reported bug ends up destroying. */
function diskPoints(device, gameId, leagueId = 'lg1') {
  const val = { fg3_make: 3, fg2_make: 2, ft_make: 1 };
  const lg = device.disk.state.leagues.find(l => l.id === leagueId);
  return (lg ? lg.events : []).filter(e => e.gameId === gameId).reduce((n, e) => n + (val[e.type] || 0), 0);
}

/* THE REPORTED BUG, WITH THE PROCESS ACTUALLY RESTARTED.

   T1.7/T1.8 above hydrate the truncated snapshot into a second `Device`, and
   every Device shares the MODULE-LEVEL pending ledger. Device A's confirmed
   writes are therefore still in memory, and the ledger's "the server disagrees
   with a write I know about" guard keeps the events alive - so T1.7/T1.8 pass
   even with `readAll` reverted. They are kept because they say something true
   (a live second device is not corrupted either), but they are NOT evidence
   about the reported bug.

   The report is a force-quit: exit the game, kill the app, reopen it. `relaunch`
   reproduces that honestly - `resetSyncPrimitives()` drops the ledger, the push
   chain and the snapshot watermark exactly as ending the process does, and the
   new device starts from what reached the disk. Confirmed writes are excluded
   from the persisted outbox, so the ledger comes back EMPTY: there is nothing
   left to object with, the truncated snapshot is believed in full, HYDRATE
   removes tonight's events as though another device had deleted them, and the
   boot autosave writes that over the last durable copy.

   With `src/sync/sync.ts` at HEAD this fails at T4.7 with 0 points, which is
   the reporter's 0-0 exactly, while T4.8 still passes - the older stats are
   what the truncated read DID return, which is also what the reporter saw. */
async function t4_a_truncated_read_survives_a_force_quit() {
  const server = new FakeServer();
  const A = await seedTwoGames(server);
  A.persist();

  eq('T4.1 tonight is 9 before the restart', A.points('g1'), 9);
  eq('T4.2 and the disk copy holds it', diskPoints(A, 'g1'), 9);
  eq('T4.3 nothing is queued to replay', unsyncedCount(), 0);
  eq('T4.4 no push reported a failure', A.pushErrors, []);

  // The cap, and nothing else: no outage, no refused write, no racing pull.
  server.maxRows = 4;

  const B = relaunch(A);
  eq('T4.5 the relaunch starts from disk with tonight intact', B.points('g1'), 9);
  // This is the whole difference from T1: the server confirmed every one of
  // these writes, so a new process has nothing pinned and believes the snapshot.
  eq('T4.6 and with an empty ledger, as a new process has', pendingCount(), 0);

  await B.pull();
  eq('T4.7 tonight is still on the board after the boot pull', B.points('g1'), 9);
  eq('T4.8 the earlier game is intact too', B.points('g0'), 8);
  eq('T4.9 and the boot autosave did not overwrite the durable copy', diskPoints(B, 'g1'), 9);
  eq('T4.10 every event came back', B.league().events.length, 7);

  // Not a lucky refusal. A pull that threw, or one the empty/stale gates
  // dropped, would leave the local copy standing and pass T4.7 having proved
  // nothing about the read - which is how the pre-fix suite stayed green.
  ok('T4.11 the snapshot was actually applied, not skipped', appliedSnapshotAt() > 0,
     `appliedSnapshotAt=${appliedSnapshotAt()}`);
  eq('T4.12 and it was not refused', B.refused, null);
}

/* AN EMPTY PROJECT IS NOT A FAILED READ.

   `readAll` refuses rather than truncating, and the easy way to write that
   refusal is to treat "fewer rows than I expected" as an error - which turns a
   first launch, or any account with no leagues yet, into a permanent sync
   error. It also has to make a request before it can decide anything: skipping
   the first page for a table believed empty would report success having read
   nothing.

   nothing. */
async function t5_an_empty_project_reads_as_empty_not_as_an_error() {
  const server = new FakeServer();
  const client = makeClient(server);

  let threw = null, snap;
  try { snap = await fetchAllState(client); } catch (e) { threw = e; }
  ok('T5.1 a read of an empty project does not throw', threw === null, threw && threw.message);
  eq('T5.2 and it is a snapshot of no leagues, not "no snapshot"', snap && snap.leagues, []);
  ok('T5.3 it did ask all five tables', server.log.filter(x => x.op === 'select').length >= 5,
     String(server.log.filter(x => x.op === 'select').length));
}

/* ==========================================================================
   GROUP U - a snapshot that does not speak for every league
   ==========================================================================

   Scoping the pull introduces a state this app has never had: a league row
   present in the catalogue whose games and events were never requested. In a
   result set that is indistinguishable from a league that HAS no games, and
   treating the second as the first is precisely how N-39 deleted a
   scorekeeper's game - HYDRATE drops the events, the autosave makes it
   permanent, and the tracker reopens at 0-0.

   So the snapshot declares what it was asked about (`covered`), and everything
   that would otherwise read absence as deletion has to consult it. These pin
   the two places that do. `covered: null` is "every league, in full", which is
   what an unscoped pull sends and what every caller sent before scoping
   existed - so U3 is the proof that none of this changed the old behaviour.
   ========================================================================== */

// Two leagues, both with a game and stats, both fully on the device.
async function twoLeaguesBothScored(server) {
  const A = await seed(server);
  A.dispatch({ t: 'ADD_LEAGUE', id: 'lg2', name: 'Other', season: 'S1' });
  A.dispatch({ t: 'ADD_TEAM', leagueId: 'lg2', name: 'Hawks', id: 'tH2' });
  A.dispatch({ t: 'ADD_TEAM', leagueId: 'lg2', name: 'Kings', id: 'tA2' });
  A.dispatch({ t: 'ADD_PLAYER', leagueId: 'lg2', teamId: 'tH2', name: 'Mika', number: '4', id: 'p3' });
  A.dispatch({ t: 'CREATE_GAME', id: 'g2', leagueId: 'lg2', homeTeamId: 'tH2', awayTeamId: 'tA2' });
  A.dispatch({ t: 'SET_GAME_STATUS', leagueId: 'lg2', gameId: 'g2', status: 'live' });
  A.dispatch(score('lg1', 'g1', 'tH', 'p1', 'fg3_make', 1));
  A.dispatch({ ...score('lg2', 'g2', 'tH2', 'p3', 'fg3_make', 1), id: 'e-lg2', ts: 4000 });
  await A.settle();
  return A;
}

// The catalogue row for a league whose heavy tables were not requested: the
// scalars the leagues table carries, and nothing else. This is the shape a
// scoped pull produces, and the shape that used to mean "everything was
// deleted".
const catalogueOnly = (league) => ({
  id: league.id, name: league.name, season: league.season, kind: league.kind,
  createdAt: league.createdAt,
  teams: [], players: [], games: [], events: [],
});

async function u1_a_scoped_snapshot_does_not_delete_what_it_never_read() {
  const server = new FakeServer();
  const A = await twoLeaguesBothScored(server);
  eq('U1.1 both leagues are scored to begin with', [A.points('g1'), A.points('g2', 'lg2')], [3, 3]);

  // A pull that asked about lg1 only. lg2 comes back as a catalogue row.
  const at = beginSnapshot();
  const remote = {
    leagues: [
      A.state.leagues.find(l => l.id === 'lg1'),
      catalogueOnly(A.state.leagues.find(l => l.id === 'lg2')),
    ],
    covered: ['lg1'],
  };
  ok('U1.2 the snapshot was applied', A.applySnapshot({ at, remote }), `refused=${A.refused}`);

  eq('U1.3 the in-scope league is intact', A.points('g1'), 3);
  eq('U1.4 the out-of-scope league keeps its stats', A.points('g2', 'lg2'), 3);
  eq('U1.5 and its game', A.game('g2', 'lg2') !== undefined, true);
  eq('U1.6 and its roster', A.league('lg2').players.length, 1);
  eq('U1.7 and its teams', A.league('lg2').teams.length, 2);
  // The catalogue fields still update - that is the whole point of sending them.
  eq('U1.8 while the catalogue row is still applied', A.league('lg2').name, 'Other');
}

async function u2_a_scoped_snapshot_does_not_prune_a_queued_write_it_never_read() {
  const server = new FakeServer();
  const A = await twoLeaguesBothScored(server);

  // A lineup change on the out-of-scope league, queued but unconfirmed - the
  // shape N-38 exists to protect.
  server.offline(true);
  A.dispatch({ t: 'SET_LINEUP', leagueId: 'lg2', gameId: 'g2', side: 'home', playerIds: ['p3'] });
  await A.settle();
  ok('U2.1 the lineup change is queued', unsyncedCount() > 0, `unsynced=${unsyncedCount()}`);
  const queued = unsyncedCount();

  // lg2 is no longer loaded, so it contributes no game ids at all - which is
  // exactly what "the game was deleted" used to look like.
  const localGameIds = new Set(['g1']);

  eq('U2.2 an unscoped prune still drops it, as it always did',
     pruneOutbox(localGameIds, null) > 0, true);

  // Rebuild and repeat with the scope declared.
  resetSyncPrimitives();
  const B = await twoLeaguesBothScored(new FakeServer());
  B.server.offline(true);
  B.dispatch({ t: 'SET_LINEUP', leagueId: 'lg2', gameId: 'g2', side: 'home', playerIds: ['p3'] });
  await B.settle();
  eq('U2.3 the same write is queued again', unsyncedCount(), queued);

  eq('U2.4 a scoped prune drops nothing for a league it did not read',
     pruneOutbox(new Set(['g1']), new Set(['lg1'])), 0);
  eq('U2.5 so the queued lineup change survives', unsyncedCount(), queued);
}

/* U1 asserts the roster and the game survive, and those are the load-bearing
   assertions: teams and players are in NO ledger, so the scope gate is the only
   thing standing between them and deletion. U1's EVENTS assertion is weaker
   than it looks - with the gate removed it still passes, because the ledger's
   "the server acknowledged this and the snapshot does not have it" branch
   re-adds them from its own copy.

   That protection expires. A confirmed entry is excluded from the persisted
   outbox, so the next launch starts with an empty ledger and nothing to object
   with - which is exactly the sequence that made N-39 permanent. So the events
   have to be asserted where the ledger cannot help them. */
async function u4_a_relaunch_with_an_empty_ledger_still_keeps_what_was_not_read() {
  const server = new FakeServer();
  const A = await twoLeaguesBothScored(server);
  A.persist();

  const B = relaunch(A);
  eq('U4.1 the relaunch has both leagues from disk', [B.points('g1'), B.points('g2', 'lg2')], [3, 3]);
  eq('U4.2 and an empty ledger, as a new process has', pendingCount(), 0);

  const at = beginSnapshot();
  const remote = {
    leagues: [
      B.state.leagues.find(l => l.id === 'lg1'),
      catalogueOnly(B.state.leagues.find(l => l.id === 'lg2')),
    ],
    covered: ['lg1'],
  };
  ok('U4.3 the scoped snapshot was applied', B.applySnapshot({ at, remote }), `refused=${B.refused}`);

  eq('U4.4 the out-of-scope stats survive with nothing pinning them', B.points('g2', 'lg2'), 3);
  eq('U4.5 and the durable copy is not overwritten with less', diskPoints(B, 'g2', 'lg2'), 3);
  eq('U4.6 the in-scope league is still correct', B.points('g1'), 3);
}

async function u3_an_unscoped_snapshot_behaves_exactly_as_before() {
  const server = new FakeServer();
  const A = await twoLeaguesBothScored(server);

  // Undo lg2's basket on the server ONLY, then pull unscoped. The old
  // behaviour - a snapshot that speaks for everything is believed about
  // everything - has to be untouched, or "covered" would have made local rows
  // permanently sticky and broken every cross-device delete.
  server.rows.events = server.rows.events.filter(r => r.id !== 'e-lg2');
  resetSyncPrimitives();
  await A.pull();

  eq('U3.1 lg1 is untouched', A.points('g1'), 3);
  eq('U3.2 and the server-side undo still lands on lg2', A.points('g2', 'lg2'), 0);
}

/* ==========================================================================
   GROUP V - one league, fetched because someone opened it
   ==========================================================================

   Phase 1 of bounding the pull. HYDRATE replaces the league list with the
   snapshot's, which is right for a full pull and would be catastrophic for a
   single-league read - it would delete every other league on the device. So
   HYDRATE_LEAGUE merges instead, and these pin that it merges rather than
   replaces, that it reconciles against the ledger like every other snapshot,
   and that `detailLoaded` tells "not fetched" apart from "empty".

   The last one matters more than it looks: every screen computing standings,
   leaders or a box score off empty arrays renders ZEROS, which is
   indistinguishable from a season that has not started - and is exactly what
   the N-39 data loss looked like to the person holding the phone.
   ========================================================================== */

const twoLeagueState = () => ({
  leagues: [
    { id: 'lg1', name: 'BPBL', season: 'S3', teams: [], players: [], games: [], events: [], createdAt: 1, detailLoaded: true },
    { id: 'lg2', name: 'Other', season: 'S1', teams: [], players: [], games: [], events: [], createdAt: 2, detailLoaded: false },
  ],
});

const detailFor = (gameId, eventId) => ({
  teams: [{ id: 'tX', name: 'Hawks', color: '#fff', playerIds: ['pX'] }],
  players: [{ id: 'pX', name: 'Mika' }],
  games: [{ id: gameId, homeTeamId: 'tX', awayTeamId: 'tX', status: 'live', homeOnCourt: [], awayOnCourt: [] }],
  events: [{ id: eventId, gameId, teamId: 'tX', playerId: 'pX', type: 'fg3_make', period: 1, ts: 100 }],
});

function v1_a_league_fetch_merges_and_never_replaces() {
  resetSyncPrimitives();
  const before = twoLeagueState();
  const at = beginSnapshot();
  const after = reducer(before, {
    t: 'HYDRATE_LEAGUE', leagueId: 'lg2', detail: detailFor('g2', 'e2'), snapshotAt: at,
  });

  eq('V1.1 both leagues are still there', after.leagues.map(l => l.id), ['lg1', 'lg2']);
  eq('V1.2 the fetched league has its detail', after.leagues[1].events.map(e => e.id), ['e2']);
  eq('V1.3 and its roster', after.leagues[1].players.length, 1);
  eq('V1.4 and is marked loaded', after.leagues[1].detailLoaded, true);
  eq('V1.5 the other league is untouched', after.leagues[0], before.leagues[0]);
}

function v2_a_league_fetch_does_not_revert_a_write_it_raced() {
  resetSyncPrimitives();
  const before = twoLeagueState();

  // The read starts...
  const at = beginSnapshot();
  // ...and while it is in flight, a basket is tapped in that league and queued.
  const withLocal = reducer(before, {
    t: 'ADD_EVENT', leagueId: 'lg2', gameId: 'g2', teamId: 'tX', playerId: 'pX',
    type: 'fg2_make', period: 1, id: 'e-local', ts: 500,
  });
  recordPending(
    { t: 'ADD_EVENT', leagueId: 'lg2', gameId: 'g2', teamId: 'tX', playerId: 'pX', type: 'fg2_make', period: 1, id: 'e-local', ts: 500 },
    before, withLocal,
  );
  ok('V2.1 the tap is in the ledger', pendingCount() > 0, `pending=${pendingCount()}`);

  // The read lands. It predates the tap, so it cannot know about it.
  const after = reducer(withLocal, {
    t: 'HYDRATE_LEAGUE', leagueId: 'lg2', detail: detailFor('g2', 'e2'), snapshotAt: at,
  });

  const ids = after.leagues[1].events.map(e => e.id).sort();
  eq('V2.2 the fetched event is there', ids.includes('e2'), true);
  eq('V2.3 and the tap it raced survives', ids.includes('e-local'), true);
}

function v3_an_unknown_league_is_not_invented() {
  resetSyncPrimitives();
  const before = twoLeagueState();
  const after = reducer(before, {
    t: 'HYDRATE_LEAGUE', leagueId: 'lg-nope', detail: detailFor('gX', 'eX'), snapshotAt: beginSnapshot(),
  });
  // The catalogue is the only thing that introduces a league. A detail read for
  // one this device has never heard of is a race with a delete, not a new
  // league, and re-adding it would resurrect what someone removed.
  eq('V3.1 state is unchanged', after, before);
}

function v4_a_saved_state_from_before_this_field_reads_as_loaded() {
  resetSyncPrimitives();
  // Every pull used to be global, so every league in a saved state written by
  // an older build genuinely WAS complete. Reading the missing field as "not
  // loaded" would put a spinner over every league on the first launch after
  // upgrading - and in a local-only build, with no server to fetch from, it
  // would never clear.
  const legacy = {
    leagues: [{ id: 'lg1', name: 'BPBL', season: 'S3', teams: [], players: [], games: [], events: [], createdAt: 1 }],
  };
  const hydrated = reducer({ leagues: [] }, { t: 'HYDRATE', state: legacy });
  eq('V4.1 a legacy saved league counts as loaded', hydrated.leagues[0].detailLoaded, true);

  // But a catalogue row that arrived from a scoped SERVER snapshot must not.
  const at = beginSnapshot();
  const scoped = reducer(hydrated, {
    t: 'HYDRATE',
    state: { leagues: [
      hydrated.leagues[0],
      { id: 'lg9', name: 'New', season: 'S1', teams: [], players: [], games: [], events: [], createdAt: 9 },
    ] },
    snapshotAt: at,
    covered: ['lg1'],
  });
  eq('V4.2 the in-scope league is loaded', scoped.leagues[0].detailLoaded, true);
  eq('V4.3 a catalogue row the snapshot did not read is NOT loaded', scoped.leagues[1].detailLoaded, false);
  // Explicit false, not undefined: undefined would be read as "legacy, assume
  // loaded" the next time this state came back off disk.
  ok('V4.4 and says so explicitly, so a save round trip cannot promote it',
     scoped.leagues[1].detailLoaded === false, JSON.stringify(scoped.leagues[1].detailLoaded));
}

/* ==========================================================================
   GROUP W - the pull reads only the leagues this device uses
   ==========================================================================

   Phase 2. Before this, every device downloaded every league's every event on
   every pull - boot, realtime refetch, pull-to-refresh and the reconnect drain.
   Measured at roughly 124 MB across twenty leagues of history, and large enough
   at around 150 that the device cannot serialise its own state. The row cap
   used to hide that by silently truncating the read, which is the N-39 bug; now
   that the read is faithful, the ceiling is real.

   The catalogue stays whole, because browsing every league IS the product. Only
   the four heavy tables are narrowed, and the snapshot says so, so HYDRATE
   leaves everything it did not read alone (GROUP U).
   ========================================================================== */

async function w1_a_scoped_pull_reads_the_catalogue_whole_and_the_rest_narrowly() {
  const server = new FakeServer();
  const A = await twoLeaguesBothScored(server);

  const snap = await fetchAllState(A.client, ['lg1']);
  eq('W1.1 the snapshot declares what it read', snap.covered, ['lg1']);
  eq('W1.2 the catalogue carries BOTH leagues', snap.leagues.map(l => l.id).sort(), ['lg1', 'lg2']);

  const lg1 = snap.leagues.find(l => l.id === 'lg1');
  const lg2 = snap.leagues.find(l => l.id === 'lg2');
  eq('W1.3 the scoped league has its events', lg1.events.length > 0, true);
  eq('W1.4 and its roster', lg1.players.length > 0, true);
  // Not "this league is empty" - this snapshot was never asked about it. The
  // `covered` field above is the only thing that distinguishes the two, which
  // is why it exists.
  eq('W1.5 the unscoped league carries no heavy rows', [lg2.events.length, lg2.games.length, lg2.players.length], [0, 0, 0]);
  eq('W1.6 but its catalogue fields are there', lg2.name, 'Other');
}

async function w2_an_empty_scope_asks_the_server_nothing_it_already_knows() {
  const server = new FakeServer();
  const A = await twoLeaguesBothScored(server);
  server.log.length = 0;

  const snap = await fetchAllState(A.client, []);
  eq('W2.1 the catalogue still comes back', snap.leagues.length, 2);
  eq('W2.2 and the scope is honestly empty, not "everything"', snap.covered, []);

  // `.in('league_id', [])` is a request whose answer is already known. A device
  // with no leagues of its own - a first launch, a spectator who has favourited
  // nothing - should not spend four round trips being told nothing.
  const heavy = server.log.filter(r => r.op === 'select' && r.table !== 'leagues');
  eq('W2.3 no heavy table was read at all', heavy.length, 0);
  ok('W2.4 while the catalogue was', server.log.some(r => r.op === 'select' && r.table === 'leagues'),
     JSON.stringify(server.log.map(r => r.table)));
}

async function w3_a_scoped_pull_does_not_cost_an_unscoped_league_its_data() {
  // The end-to-end version of GROUP U, driven through the real scoped read
  // rather than a hand-built snapshot, and across a relaunch so the ledger is
  // empty and nothing local is pinned.
  const server = new FakeServer();
  const A = await twoLeaguesBothScored(server);
  A.persist();

  const B = relaunch(A);
  eq('W3.1 the relaunch has both leagues from disk', [B.points('g1'), B.points('g2', 'lg2')], [3, 3]);
  eq('W3.2 and an empty ledger', pendingCount(), 0);

  B.applySnapshot(await B.snapshot(['lg1']));
  eq('W3.3 the scoped league is correct', B.points('g1'), 3);
  eq('W3.4 the unscoped league keeps its stats', B.points('g2', 'lg2'), 3);
  eq('W3.5 and its roster', B.league('lg2').players.length, 1);
  eq('W3.6 while still being listed', B.state.leagues.map(l => l.id).sort(), ['lg1', 'lg2']);
}

async function w4_one_league_can_be_fetched_on_its_own() {
  const server = new FakeServer();
  const A = await twoLeaguesBothScored(server);

  const detail = await fetchLeagueDetail(A.client, 'lg2');
  ok('W4.1 the detail read succeeded', detail !== null, 'null');
  eq('W4.2 it carries only that league\'s events', detail.events.map(e => e.id), ['e-lg2']);
  eq('W4.3 and only its roster', detail.players.map(p => p.id), ['p3']);
  eq('W4.4 and only its games', detail.games.map(g => g.id), ['g2']);
  eq('W4.5 and only its teams', detail.teams.map(t => t.id).sort(), ['tA2', 'tH2']);
}

async function w5_memberships_are_read_and_a_failure_is_unknown_not_none() {
  const server = new FakeServer();
  const A = await seed(server);
  server.memberships = ['lg1', 'lg7'];

  eq('W5.1 memberships come back', (await fetchMemberships(A.client)).sort(), ['lg1', 'lg7']);

  // A refused RPC must read as "unknown", never as "this account runs nothing".
  // Scoping a scorekeeper's own league out of the pull because an RPC failed is
  // how their game stops syncing.
  server.failures['rpc:my_memberships'] = { message: 'permission denied' };
  eq('W5.2 a refusal is unknown, not an empty list', await fetchMemberships(A.client), null);

  // A transport failure is offline, and has to be distinguishable from both.
  server.failures['rpc:my_memberships'] = 'network-resolved';
  let threw = null;
  try { await fetchMemberships(A.client); } catch (e) { threw = e; }
  ok('W5.3 a transport failure throws rather than reporting none', threw !== null, 'did not throw');
}

/* ==========================================================================
   GROUP X - the one cross-league view that survives scoping
   ==========================================================================

   Scoping the pull would otherwise narrow the Home banner to the leagues a
   device happens to use, and a fan browsing for something to watch is the
   whole point of it. So live games get their own narrow read.

   It stays cheap because "live" is a tiny slice, and because the banner draws
   the league name, the matchup and the location and NOTHING ELSE - no score. So
   this read never touches the events table, which is the one that grows without
   bound.
   ========================================================================== */

async function x1_live_games_are_found_in_leagues_the_device_never_loaded() {
  const server = new FakeServer();
  const A = await twoLeaguesBothScored(server);
  // Both games were set live by the seed helpers.
  const live = await fetchLiveGames(A.client);

  eq('X1.1 both live games are found', live.map(x => x.gameId).sort(), ['g1', 'g2']);
  const g2 = live.find(x => x.gameId === 'g2');
  eq('X1.2 with the league it belongs to', g2.leagueId, 'lg2');
  eq('X1.3 and the team names the banner draws', [g2.homeName, g2.awayName], ['Hawks', 'Kings']);
}

async function x2_the_live_read_never_touches_the_events_table() {
  const server = new FakeServer();
  const A = await twoLeaguesBothScored(server);
  server.log.length = 0;

  await fetchLiveGames(A.client);
  const tables = [...new Set(server.log.filter(r => r.op === 'select').map(r => r.table))].sort();
  // The banner shows no score, so the table that grows without bound is not
  // read at all. If that ever changes, this read stops being cheap and the
  // whole point of scoping is undone on every pull.
  eq('X2.1 only games and teams are read', tables, ['games', 'teams']);
  ok('X2.2 the events table is untouched', !tables.includes('events'), tables.join(','));
}

async function x3_a_finished_game_drops_out_of_the_banner() {
  const server = new FakeServer();
  const A = await twoLeaguesBothScored(server);
  A.dispatch({ t: 'SET_GAME_STATUS', leagueId: 'lg2', gameId: 'g2', status: 'final' });
  await A.settle();

  const live = await fetchLiveGames(A.client);
  eq('X3.1 only the still-live game is listed', live.map(x => x.gameId), ['g1']);
}

async function x4_no_live_games_is_an_empty_list_not_a_failure() {
  const server = new FakeServer();
  const A = await twoLeaguesBothScored(server);
  A.dispatch({ t: 'SET_GAME_STATUS', leagueId: 'lg1', gameId: 'g1', status: 'final' });
  A.dispatch({ t: 'SET_GAME_STATUS', leagueId: 'lg2', gameId: 'g2', status: 'final' });
  await A.settle();
  server.log.length = 0;

  const live = await fetchLiveGames(A.client);
  eq('X4.1 an empty list, not null', live, []);
  // Nothing named a team, so there is nothing to look up. A quiet Tuesday
  // should cost one request, not two.
  const tables = server.log.filter(r => r.op === 'select').map(r => r.table);
  eq('X4.2 and the team lookup is skipped entirely', tables, ['games']);
}

async function x5_a_transport_failure_throws_and_a_refusal_returns_null() {
  const server = new FakeServer();
  const A = await twoLeaguesBothScored(server);

  // A refused read is not the same as an unreachable one, and the banner must
  // not be the thing that decides the device is offline.
  server.failures['select:games'] = { message: 'permission denied for table games' };
  eq('X5.1 a refusal is null, not a throw', await fetchLiveGames(A.client), null);

  delete server.failures['select:games'];
  server.failures['select:games'] = 'network-resolved';
  let threw = null;
  try { await fetchLiveGames(A.client); } catch (e) { threw = e; }
  ok('X5.2 a transport failure throws', threw !== null, 'did not throw');
}

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
  ['O1 the loss is real without a durable queue', o1_the_loss_is_real_without_a_durable_queue],
  ['O2 a restored outbox keeps the stats', o2_a_restored_outbox_keeps_the_stats],
  ['O3 replay cannot duplicate a stat', o3_replay_cannot_duplicate_a_stat],
  ['O4 a new stat does not report the old ones saved', o4_a_new_stat_does_not_report_the_old_ones_saved],
  ['O5 a refused write stays queued and is retried', o5_a_refused_write_stays_queued_and_is_retried],
  ['O6 repeated transitions lose nothing', o6_repeated_transitions_lose_nothing],
  ['O7 a drain stops when the connection dies again', o7_a_drain_stops_when_the_connection_dies_again],
  ['O8 an offline undo is replayed as a delete', o8_an_offline_undo_is_replayed_as_a_delete],
  ['O9 a write for a deleted game is never replayed', o9_a_write_for_a_deleted_game_is_never_replayed],
  ['O10 connectivity is observed, not assumed', o10_connectivity_is_observed_not_assumed],
  ['O11 the summary says what is true', o11_the_summary_says_what_is_true],
  ['O12 a pull alone clears a stale Not saved', o12_a_pull_alone_clears_a_stale_not_saved],
  ['O13 a malformed outbox never breaks a launch', o13_a_malformed_outbox_never_breaks_a_launch],
  ['O14 an offline game write is queued, not confirmed', o14_an_offline_game_write_is_queued_not_confirmed],
  ['O15 a substitution survives a relaunch', o15_a_substitution_survives_a_relaunch],
  ['O16 the probe reads the response, not a throw', o16_the_probe_reads_the_response_not_a_throw],
  ['O17 a dead read is not a bad read', o17_a_dead_read_is_not_a_bad_read],
  ['O18 one transport, two spellings', o18_one_transport_two_spellings],
  ['O19 both transports leave the same ledger', o19_both_transports_leave_the_same_ledger],
  ['R1 a refused game write is queued, not confirmed', r1_a_refused_game_write_is_queued_not_confirmed],
  ['R2 a refusal is reported by the push itself', r2_a_refusal_is_reported_by_the_push_itself],
  ['R3 a game created offline is queued and survives the pull', r3_a_game_created_offline_is_queued_and_survives_the_pull],
  ['R4 a created game deleted before it syncs is not resurrected', r4_a_created_game_deleted_before_it_syncs_is_not_resurrected],
  ['T1 a capped reply is not the whole table', t1_a_capped_reply_is_not_the_whole_table],
  ['T2 paging does not assume the server cap', t2_paging_does_not_assume_the_servers_cap],
  ['T3 an unfinishable read fails rather than truncating', t3_an_unfinishable_read_fails_rather_than_truncating],
  ['T4 a truncated read survives a force-quit', t4_a_truncated_read_survives_a_force_quit],
  ['T5 an empty project reads as empty, not as an error', t5_an_empty_project_reads_as_empty_not_as_an_error],
  ['T6 a delete mid-read cannot skip a surviving row', t6_a_delete_mid_read_cannot_skip_a_surviving_row],
  ['T7 a delete mid-read does not cost the game on relaunch', t7_a_delete_mid_read_does_not_cost_the_game_on_relaunch],
  ['T8 only an empty page proves the walk finished', t8_only_an_empty_page_proves_the_walk_finished],
  ['U1 a scoped snapshot does not delete what it never read', u1_a_scoped_snapshot_does_not_delete_what_it_never_read],
  ['U2 a scoped snapshot does not prune a queued write it never read', u2_a_scoped_snapshot_does_not_prune_a_queued_write_it_never_read],
  ['U3 an unscoped snapshot behaves exactly as before', u3_an_unscoped_snapshot_behaves_exactly_as_before],
  ['U4 a relaunch with an empty ledger still keeps what was not read', u4_a_relaunch_with_an_empty_ledger_still_keeps_what_was_not_read],
  ['V1 a league fetch merges and never replaces', v1_a_league_fetch_merges_and_never_replaces],
  ['V2 a league fetch does not revert a write it raced', v2_a_league_fetch_does_not_revert_a_write_it_raced],
  ['V3 an unknown league is not invented', v3_an_unknown_league_is_not_invented],
  ['V4 a saved state from before this field reads as loaded', v4_a_saved_state_from_before_this_field_reads_as_loaded],
  ['W1 a scoped pull reads the catalogue whole and the rest narrowly', w1_a_scoped_pull_reads_the_catalogue_whole_and_the_rest_narrowly],
  ['W2 an empty scope asks the server nothing it already knows', w2_an_empty_scope_asks_the_server_nothing_it_already_knows],
  ['W3 a scoped pull does not cost an unscoped league its data', w3_a_scoped_pull_does_not_cost_an_unscoped_league_its_data],
  ['W4 one league can be fetched on its own', w4_one_league_can_be_fetched_on_its_own],
  ['W5 memberships are read, and a failure is unknown not none', w5_memberships_are_read_and_a_failure_is_unknown_not_none],
  ['X1 live games are found in leagues the device never loaded', x1_live_games_are_found_in_leagues_the_device_never_loaded],
  ['X2 the live read never touches the events table', x2_the_live_read_never_touches_the_events_table],
  ['X3 a finished game drops out of the banner', x3_a_finished_game_drops_out_of_the_banner],
  ['X4 no live games is an empty list, not a failure', x4_no_live_games_is_an_empty_list_not_a_failure],
  ['X5 a transport failure throws and a refusal returns null', x5_a_transport_failure_throws_and_a_refusal_returns_null],
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
