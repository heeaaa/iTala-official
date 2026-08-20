import { describe, expect, it } from 'vitest';
import { initialState, project, reduce, type Action, type AppState } from '@itala/domain';
import { drainOnce, planReconcile, planRealtime, backoffDelay } from '../index';
import { FakeRemote, FakeServer, MemoryStore } from './fakes';

/**
 * A device: local store, its own view of the world, and a link to the server
 * that can be switched off. Actions go through the real domain reducer, so
 * these tests run the whole path from "scorekeeper taps a stat" to "row on the
 * server", with only the storage and network edges faked.
 */
class Device {
  store = new MemoryStore();
  remote: FakeRemote;
  state: AppState = initialState();
  private clock: number;

  constructor(
    private server: FakeServer,
    startTime = 1_000_000,
  ) {
    this.remote = new FakeRemote(server);
    this.clock = startTime;
  }

  get online(): boolean {
    return this.remote.online;
  }
  set online(v: boolean) {
    this.remote.online = v;
  }

  tick(ms = 1): number {
    this.clock += ms;
    return this.clock;
  }

  /**
   * Rebuilds the domain state from local rows. In the real app this is what
   * happens after any inbound change: the store is the record, the state is a
   * projection of it.
   */
  private refresh(): void {
    const rows = (t: 'leagues' | 'teams' | 'players' | 'games' | 'events') => [
      ...(this.store.tables.get(t)?.values() ?? []),
    ];
    this.state = project({
      leagues: rows('leagues'),
      teams: rows('teams'),
      players: rows('players'),
      games: rows('games'),
      events: rows('events'),
    });
  }

  async dispatch(action: Action): Promise<void> {
    const { state, ops } = reduce(this.state, action);
    this.state = state;
    await this.store.commit(ops, ops, this.tick());
  }

  async drain(): Promise<Awaited<ReturnType<typeof drainOnce>>> {
    // Wind the clock well past any scheduled backoff so a test never waits in
    // real time, and so consecutive drains are genuinely later than each other.
    this.clock += 10_000_000;
    return drainOnce(this.store, this.remote, this.clock, { random: () => 0.5 });
  }

  async reconcile(): Promise<number> {
    const snap = await this.remote.fetchAll();
    if (!snap) return 0;
    const plan = planReconcile(await this.store.localIds(), snap, await this.store.pendingKeys());
    await this.store.applyRemote(plan.ops);
    this.refresh();
    return plan.skipped;
  }
}

/** League, two teams, one player each, one live game. Shared setup. */
function setupActions(now: number): Action[] {
  return [
    { t: 'ADD_LEAGUE', id: 'lg', now, name: 'Sunday Run', season: 'Spring 2026' },
    { t: 'ADD_TEAM', id: 'tA', leagueId: 'lg', name: 'Riptide' },
    { t: 'ADD_TEAM', id: 'tB', leagueId: 'lg', name: 'Coastal' },
    { t: 'ADD_PLAYER', id: 'p1', leagueId: 'lg', teamId: 'tA', name: 'Ana', number: '7' },
    { t: 'ADD_PLAYER', id: 'p2', leagueId: 'lg', teamId: 'tB', name: 'Dee', number: '11' },
    { t: 'CREATE_GAME', id: 'g1', now, leagueId: 'lg', homeTeamId: 'tA', awayTeamId: 'tB' },
  ];
}

const statAction = (id: string, now: number, teamId: string, playerId: string): Action => ({
  t: 'ADD_EVENT',
  id,
  now,
  leagueId: 'lg',
  gameId: 'g1',
  teamId,
  playerId,
  type: 'fg2_make',
  period: 1,
});

describe('THE PHASE 1 ACCEPTANCE TEST: two devices, one of them offline', () => {
  it('loses nothing and duplicates nothing across an outage', async () => {
    const server = new FakeServer();
    const a = new Device(server);
    const b = new Device(server, 2_000_000);

    // A sets the league up and syncs it.
    for (const action of setupActions(a.tick())) await a.dispatch(action);
    await a.drain();

    // B picks it up, then loses signal mid-game.
    await b.reconcile();
    b.online = false;

    // Both scorekeepers log 20 stats each. B is on a dead network throughout.
    for (let i = 0; i < 20; i++) {
      await a.dispatch(statAction(`a-e${i}`, a.tick(), 'tA', 'p1'));
      await b.dispatch(statAction(`b-e${i}`, b.tick(), 'tB', 'p2'));
    }
    await a.drain();

    // A's 20 are up. B's 20 are queued locally and none are lost.
    expect(server.count('events')).toBe(20);
    expect((await b.store.counts()).pending).toBe(20);
    expect(b.store.count('events')).toBe(20);

    // B reconnects.
    b.online = true;
    const report = await b.drain();

    expect(report.sent).toBe(20);
    expect(report.rejected).toBe(0);
    expect(report.blocked).toBe(false);
    expect((await b.store.counts()).pending).toBe(0);

    // EXACTLY 40 events on the server. None lost, none duplicated.
    expect(server.count('events')).toBe(40);
    expect(new Set(server.tables.get('events')?.keys()).size).toBe(40);

    // A third device that never had local data sees all of them.
    const c = new Device(server, 3_000_000);
    await c.reconcile();
    expect(c.store.count('events')).toBe(40);
    expect(c.store.count('teams')).toBe(2);
    expect(c.store.count('players')).toBe(2);
  });

  it('survives the drain being interrupted and restarted', async () => {
    const server = new FakeServer();
    const d = new Device(server);
    for (const action of setupActions(d.tick())) await d.dispatch(action);
    await d.drain();

    d.online = false;
    for (let i = 0; i < 10; i++) await d.dispatch(statAction(`e${i}`, d.tick(), 'tA', 'p1'));

    // The network flaps: up for a couple of sends, down again, then up.
    d.online = true;
    let sends = 0;
    const realSend = d.remote.send.bind(d.remote);
    d.remote.send = async (op) => {
      if (sends++ >= 3) return { status: 'retry', message: 'connection reset' };
      return realSend(op);
    };
    const first = await d.drain();
    expect(first.sent).toBe(3);
    expect(first.blocked).toBe(true);

    d.remote.send = realSend;
    const second = await d.drain();
    expect(second.sent).toBe(7);
    expect(server.count('events')).toBe(10);
    expect((await d.store.counts()).pending).toBe(0);
  });

  it('treats a replayed insert as success rather than a second stat', async () => {
    const server = new FakeServer();
    const d = new Device(server);
    for (const action of setupActions(d.tick())) await d.dispatch(action);
    await d.drain();

    // The server accepted the write but the response never arrived, so the
    // entry stayed in the outbox and gets sent again.
    await d.dispatch(statAction('e1', d.tick(), 'tA', 'p1'));
    const entry = (await d.store.head(10))[0]!;
    await d.remote.send(entry.op);
    expect(server.count('events')).toBe(1);

    const report = await d.drain();
    expect(report.duplicates).toBe(1);
    expect(report.sent).toBe(0);
    expect(server.count('events')).toBe(1);
    expect((await d.store.counts()).pending).toBe(0);
  });
});

describe('UNDO across devices (v1 hole H-1)', () => {
  it('deletes the event on the server and it does not come back', async () => {
    const server = new FakeServer();
    const a = new Device(server);
    for (const action of setupActions(a.tick())) await a.dispatch(action);
    await a.dispatch(statAction('e1', a.tick(), 'tA', 'p1'));
    await a.dispatch(statAction('e2', a.tick(), 'tA', 'p1'));
    await a.drain();
    expect(server.count('events')).toBe(2);

    await a.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg', gameId: 'g1' });
    await a.drain();

    // Gone locally AND on the server. In v1 the delete produced no operation
    // at all, so the event stayed on the server and the next refetch on any
    // device brought it straight back.
    expect(a.store.has('events', 'e2')).toBe(false);
    expect(server.count('events')).toBe(1);

    await a.reconcile();
    expect(a.store.has('events', 'e2')).toBe(false);

    const b = new Device(server, 2_000_000);
    await b.reconcile();
    expect(b.store.count('events')).toBe(1);
    expect(b.store.has('events', 'e2')).toBe(false);
  });

  it('works while offline and delivers the deletion on reconnect', async () => {
    const server = new FakeServer();
    const a = new Device(server);
    for (const action of setupActions(a.tick())) await a.dispatch(action);
    await a.dispatch(statAction('e1', a.tick(), 'tA', 'p1'));
    await a.drain();

    a.online = false;
    await a.dispatch(statAction('e2', a.tick(), 'tA', 'p1'));
    await a.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg', gameId: 'g1' });
    expect(a.store.has('events', 'e2')).toBe(false);

    a.online = true;
    await a.drain();
    // The insert and the delete both went, in that order, so the server ends
    // up in the same place the scorekeeper sees.
    expect(server.count('events')).toBe(1);
    expect(server.tables.get('events')?.has('e2')).toBe(false);
  });
});

describe('a pull never destroys unsent local work (v1 hole H-8)', () => {
  it('leaves a league created offline alone', async () => {
    const server = new FakeServer();
    const d = new Device(server);
    for (const action of setupActions(d.tick())) await d.dispatch(action);
    await d.drain();

    d.online = false;
    await d.dispatch({
      t: 'ADD_LEAGUE',
      id: 'offline-lg',
      now: d.tick(),
      name: 'Created in a gym with no signal',
      season: 'S',
    });
    for (let i = 0; i < 5; i++) await d.dispatch(statAction(`e${i}`, d.tick(), 'tA', 'p1'));

    // Something else changes remotely and triggers a reconcile while we are
    // still offline for writes but able to read.
    d.online = true;
    const skipped = await d.reconcile();

    expect(d.store.has('leagues', 'offline-lg')).toBe(true);
    expect(d.store.count('events')).toBe(5);
    expect(skipped).toBeGreaterThan(0);

    await d.drain();
    expect(server.tables.get('leagues')?.has('offline-lg')).toBe(true);
  });

  it('does delete a row another device genuinely removed', async () => {
    const server = new FakeServer();
    const a = new Device(server);
    const b = new Device(server, 2_000_000);
    for (const action of setupActions(a.tick())) await a.dispatch(action);
    await a.dispatch(statAction('e1', a.tick(), 'tA', 'p1'));
    await a.drain();
    await b.reconcile();
    expect(b.store.has('events', 'e1')).toBe(true);

    await a.dispatch({ t: 'UNDO_EVENT', leagueId: 'lg', gameId: 'g1' });
    await a.drain();

    await b.reconcile();
    expect(b.store.has('events', 'e1')).toBe(false);
  });
});

describe('writes that will never succeed are surfaced, not swallowed', () => {
  it('moves an authorisation refusal aside and reports it', async () => {
    const server = new FakeServer();
    const d = new Device(server);
    for (const action of setupActions(d.tick())) await d.dispatch(action);
    await d.drain();

    // The scorekeeper was locked out on another device, so RLS now refuses.
    d.remote.refuse = (op) => op.table === 'events';
    for (let i = 0; i < 3; i++) await d.dispatch(statAction(`e${i}`, d.tick(), 'tA', 'p1'));

    const report = await d.drain();
    expect(report.rejected).toBe(3);
    expect(report.pending).toBe(0);
    expect((await d.store.counts()).rejected).toBe(3);
    // v1 logged this to the console and carried on as if nothing happened.
    expect(d.store.rejected[0]!.message).toMatch(/row-level security/);
  });

  it('keeps retrying a network failure instead of dropping it', async () => {
    const server = new FakeServer();
    const d = new Device(server);
    for (const action of setupActions(d.tick())) await d.dispatch(action);
    d.online = false;

    for (let i = 0; i < 3; i++) {
      const r = await d.drain();
      expect(r.sent).toBe(0);
      expect(r.blocked).toBe(true);
    }
    expect((await d.store.counts()).pending).toBe(8);
    expect((await d.store.counts()).rejected).toBe(0);

    d.online = true;
    const done = await d.drain();
    expect(done.sent).toBe(8);
  });

  it('does not let later entries overtake a deferred one', async () => {
    // Regression test. An earlier drainer filtered the queue by schedule, so a
    // backed-off head entry was skipped while everything behind it sailed past
    // and a team could reach the server before its league.
    const server = new FakeServer();
    const d = new Device(server);
    d.online = false;
    for (const action of setupActions(d.tick())) await d.dispatch(action);

    // One failed attempt schedules the head into the future.
    await drainOnce(d.store, d.remote, 2_000_000, { random: () => 0.5 });
    const head = (await d.store.head(1))[0]!;
    expect(head.attempts).toBe(1);
    expect(head.nextAttemptAt).toBeGreaterThan(2_000_000);

    // The network is back, but the head is not due yet. Nothing may go.
    d.online = true;
    const report = await drainOnce(d.store, d.remote, 2_000_100, { random: () => 0.5 });
    expect(report.sent).toBe(0);
    expect(report.blocked).toBe(true);
    expect(server.count('leagues')).toBe(0);
    expect(server.count('teams')).toBe(0);

    // Once it is due, the whole queue drains in order.
    const later = await drainOnce(d.store, d.remote, 9_999_999, { random: () => 0.5 });
    expect(later.sent).toBe(8);
    expect(d.remote.sent[0]!.table).toBe('leagues');
  });
});

describe('ordering', () => {
  it('never delivers a child before its parent', async () => {
    const server = new FakeServer();
    const d = new Device(server);
    d.online = false;
    for (const action of setupActions(d.tick())) await d.dispatch(action);
    await d.dispatch(statAction('e1', d.tick(), 'tA', 'p1'));

    d.online = true;
    await d.drain();

    const order = d.remote.sent.map((op) => op.table);
    expect(order.indexOf('leagues')).toBeLessThan(order.indexOf('teams'));
    expect(order.indexOf('teams')).toBeLessThan(order.indexOf('players'));
    expect(order.indexOf('games')).toBeLessThan(order.indexOf('events'));
  });

  it('stops at the first retryable failure rather than skipping ahead', async () => {
    const server = new FakeServer();
    const d = new Device(server);
    d.online = false;
    for (const action of setupActions(d.tick())) await d.dispatch(action);

    d.online = true;
    let n = 0;
    const real = d.remote.send.bind(d.remote);
    d.remote.send = async (op) => (n++ === 1 ? { status: 'retry', message: 'timeout' } : real(op));

    const report = await d.drain();
    expect(report.sent).toBe(1);
    expect(report.blocked).toBe(true);
    // Nothing after the failure was attempted.
    expect(d.remote.sent.length).toBe(1);
  });
});

describe('realtime application (v1 refetched the whole database instead)', () => {
  it('applies an inbound row directly', () => {
    const op = planRealtime(
      { table: 'events', eventType: 'INSERT', new: { id: 'e9', type: 'reb' } },
      new Set(),
    );
    expect(op).toEqual({ op: 'upsert', table: 'events', row: { id: 'e9', type: 'reb' } });
  });

  it('applies a delete from the primary key alone', () => {
    expect(
      planRealtime({ table: 'events', eventType: 'DELETE', old: { id: 'e9' } }, new Set()),
    ).toEqual({ op: 'delete', table: 'events', id: 'e9' });
  });

  it('ignores a change to a row we are still trying to write', () => {
    const pending = new Set(['events:e9']);
    expect(
      planRealtime({ table: 'events', eventType: 'DELETE', old: { id: 'e9' } }, pending),
    ).toBeNull();
    expect(
      planRealtime({ table: 'events', eventType: 'UPDATE', new: { id: 'e9' } }, pending),
    ).toBeNull();
  });

  it('ignores a malformed payload rather than throwing', () => {
    expect(planRealtime({ table: 'events', eventType: 'DELETE', old: null }, new Set())).toBeNull();
    expect(planRealtime({ table: 'events', eventType: 'INSERT', new: null }, new Set())).toBeNull();
  });
});

describe('backoff', () => {
  it('grows exponentially and stops at the ceiling', () => {
    const no = () => 0;
    expect(backoffDelay(0, undefined, no)).toBe(1_000);
    expect(backoffDelay(1, undefined, no)).toBe(2_000);
    expect(backoffDelay(5, undefined, no)).toBe(32_000);
    expect(backoffDelay(20, undefined, no)).toBe(60_000);
  });

  it('jitters downward so devices do not retry in lockstep', () => {
    expect(backoffDelay(3, undefined, () => 1)).toBe(6_000);
    expect(backoffDelay(3, undefined, () => 0)).toBe(8_000);
  });
});
