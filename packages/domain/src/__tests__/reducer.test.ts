import { describe, expect, it } from 'vitest';
import { initialState, reduce, type Action } from '../reducer';
import { TEAM_COLORS } from '../constants';
import { gameScore, playerFouls } from '../stats';
import type { AppState } from '../types';
import type { Op } from '../ops';

/** Narrows an op to one that carries a row, so tests can assert on its shape. */
function rowOf(op: Op | undefined): Record<string, unknown> {
  if (!op || op.op === 'delete') throw new Error(`expected a row-carrying op, got ${op?.op}`);
  return op.row;
}

/** Applies a script of actions and returns the final state plus every op emitted. */
function run(actions: Action[], from: AppState = initialState()) {
  let state = from;
  const ops = [];
  for (const a of actions) {
    const r = reduce(state, a);
    state = r.state;
    ops.push(...r.ops);
  }
  return { state, ops };
}

const setup: Action[] = [
  { t: 'ADD_LEAGUE', id: 'lg', now: 1000, name: 'Sunday Run', season: 'Spring 2026' },
  { t: 'ADD_TEAM', id: 'tA', leagueId: 'lg', name: 'Riptide' },
  { t: 'ADD_TEAM', id: 'tB', leagueId: 'lg', name: 'Coastal' },
  { t: 'ADD_PLAYER', id: 'p1', leagueId: 'lg', teamId: 'tA', name: 'Ana', number: '7' },
  { t: 'ADD_PLAYER', id: 'p2', leagueId: 'lg', teamId: 'tA', name: 'Ben', number: '23' },
  { t: 'ADD_PLAYER', id: 'p3', leagueId: 'lg', teamId: 'tB', name: 'Dee', number: '11' },
  { t: 'CREATE_GAME', id: 'g1', now: 2000, leagueId: 'lg', homeTeamId: 'tA', awayTeamId: 'tB' },
  { t: 'SET_LINEUP', leagueId: 'lg', gameId: 'g1', side: 'home', playerIds: ['p1', 'p2'] },
];

describe('the reducer is pure', () => {
  it('produces identical output for identical input', () => {
    const a = run(setup);
    const b = run(setup);
    expect(a.state).toEqual(b.state);
    expect(a.ops).toEqual(b.ops);
  });

  it('does not mutate the state it was given', () => {
    const { state } = run(setup);
    const snapshot = JSON.parse(JSON.stringify(state)) as AppState;
    reduce(state, {
      t: 'ADD_EVENT',
      id: 'e1',
      now: 3000,
      leagueId: 'lg',
      gameId: 'g1',
      teamId: 'tA',
      playerId: 'p1',
      type: 'fg2_make',
      period: 1,
    });
    expect(state).toEqual(snapshot);
  });
});

describe('creation defaults (spec F-1, F-7, F-12)', () => {
  it('falls back to sensible names and applies league defaults', () => {
    const { state } = run([
      { t: 'ADD_LEAGUE', id: 'lg', now: 1, name: '   ', season: '  ' },
      { t: 'ADD_TEAM', id: 't1', leagueId: 'lg', name: '  ' },
      { t: 'ADD_PLAYER', id: 'p1', leagueId: 'lg', teamId: 't1', name: '  ', number: '  ' },
    ]);
    const l = state.leagues[0]!;
    expect(l).toMatchObject({
      name: 'New League',
      season: 'Season 1',
      kind: 'league',
      foulOutLimit: 5,
      regulationPeriods: 4,
      trackMisses: true,
      trackTurnovers: false,
    });
    expect(l.teams[0]!.name).toBe('Team 1');
    expect(l.players[0]!.name).toBe('Player');
    expect(l.players[0]!.number).toBeNull();
  });

  it('assigns team colours by insertion order, wrapping after eight', () => {
    const actions: Action[] = [{ t: 'ADD_LEAGUE', id: 'lg', now: 1, name: 'L', season: 'S' }];
    for (let i = 0; i < 9; i++) {
      actions.push({ t: 'ADD_TEAM', id: `t${i}`, leagueId: 'lg', name: `T${i}` });
    }
    const { state } = run(actions);
    const colors = state.leagues[0]!.teams.map((t) => t.color);
    expect(colors[0]).toBe(TEAM_COLORS[0]);
    expect(colors[7]).toBe(TEAM_COLORS[7]);
    expect(colors[8]).toBe(TEAM_COLORS[0]);
  });

  it('keeps jersey numbers as strings so 00 and 0 stay distinct', () => {
    const { state } = run([
      { t: 'ADD_LEAGUE', id: 'lg', now: 1, name: 'L', season: 'S' },
      { t: 'ADD_TEAM', id: 't1', leagueId: 'lg', name: 'T' },
      { t: 'ADD_PLAYER', id: 'p1', leagueId: 'lg', teamId: 't1', name: 'A', number: '00' },
      { t: 'ADD_PLAYER', id: 'p2', leagueId: 'lg', teamId: 't1', name: 'B', number: '0' },
    ]);
    expect(state.leagues[0]!.players.map((p) => p.number)).toEqual(['00', '0']);
  });

  it('creates games already live, because there is no scheduling path', () => {
    const { state } = run(setup);
    expect(state.leagues[0]!.games[0]!.status).toBe('live');
  });
});

describe('every mutation emits the exact rows to sync (fixes v1 S-2 and T-2)', () => {
  it('names the row it created rather than leaving sync to guess', () => {
    const { ops } = run(setup);
    const teamUpserts = ops.filter((o) => o.table === 'teams' && o.op === 'upsert');
    // Two team creations plus two roster changes from adding players to tA.
    expect(teamUpserts.map((o) => rowOf(o).id)).toEqual(['tA', 'tB', 'tA', 'tA', 'tB']);
  });

  it('pushes the team alongside the player, because the roster array changed', () => {
    const { ops } = run([
      { t: 'ADD_LEAGUE', id: 'lg', now: 1, name: 'L', season: 'S' },
      { t: 'ADD_TEAM', id: 't1', leagueId: 'lg', name: 'T' },
      { t: 'ADD_PLAYER', id: 'p1', leagueId: 'lg', teamId: 't1', name: 'A' },
    ]);
    const last2 = ops.slice(-2);
    expect(last2[0]).toMatchObject({ op: 'upsert', table: 'players' });
    expect(last2[1]).toMatchObject({ op: 'upsert', table: 'teams' });
    expect(rowOf(last2[1]).player_ids).toEqual(['p1']);
  });

  it('serialises rows in the database snake_case shape', () => {
    const { ops } = run([
      ...setup,
      {
        t: 'ADD_EVENT',
        id: 'e1',
        now: 3000,
        leagueId: 'lg',
        gameId: 'g1',
        teamId: 'tA',
        playerId: 'p1',
        type: 'fg3_make',
        period: 2,
      },
    ]);
    const insert = ops.find((o) => o.op === 'insert')!;
    expect(insert).toEqual({
      op: 'insert',
      table: 'events',
      row: {
        id: 'e1',
        league_id: 'lg',
        game_id: 'g1',
        team_id: 'tA',
        player_id: 'p1',
        type: 'fg3_make',
        period: 2,
        ts: 3000,
        note: null,
      },
    });
  });

  it('inserts events rather than upserting them, so a replay cannot duplicate a stat', () => {
    const { ops } = run([
      ...setup,
      {
        t: 'ADD_EVENT',
        id: 'e1',
        now: 3000,
        leagueId: 'lg',
        gameId: 'g1',
        teamId: 'tA',
        playerId: 'p1',
        type: 'fg2_make',
        period: 1,
      },
    ]);
    expect(ops.find((o) => o.table === 'events')!.op).toBe('insert');
  });
});

describe('UNDO_EVENT syncs the deletion (fixes v1 H-1)', () => {
  const script: Action[] = [
    ...setup,
    {
      t: 'ADD_EVENT',
      id: 'e1',
      now: 3000,
      leagueId: 'lg',
      gameId: 'g1',
      teamId: 'tA',
      playerId: 'p1',
      type: 'fg2_make',
      period: 1,
    },
    {
      t: 'ADD_EVENT',
      id: 'e2',
      now: 3001,
      leagueId: 'lg',
      gameId: 'g1',
      teamId: 'tA',
      playerId: 'p1',
      type: 'fg3_make',
      period: 1,
    },
  ];

  it('removes the last event of that game locally', () => {
    const before = run(script);
    expect(gameScore(before.state.leagues[0]!, before.state.leagues[0]!.games[0]!).home).toBe(5);
    const after = reduce(before.state, { t: 'UNDO_EVENT', leagueId: 'lg', gameId: 'g1' });
    expect(gameScore(after.state.leagues[0]!, after.state.leagues[0]!.games[0]!).home).toBe(2);
  });

  it('emits a delete carrying the id, so the event cannot be resurrected by a refetch', () => {
    const before = run(script);
    const after = reduce(before.state, { t: 'UNDO_EVENT', leagueId: 'lg', gameId: 'g1' });
    expect(after.ops).toEqual([{ op: 'delete', table: 'events', id: 'e2' }]);
  });

  it('is a no-op on a game with no events', () => {
    const before = run(setup);
    const after = reduce(before.state, { t: 'UNDO_EVENT', leagueId: 'lg', gameId: 'g1' });
    expect(after.ops).toEqual([]);
    expect(after.state).toEqual(before.state);
  });

  it('undoes only the named game, leaving another live game untouched', () => {
    const two = run([
      ...script,
      { t: 'CREATE_GAME', id: 'g2', now: 4000, leagueId: 'lg', homeTeamId: 'tA', awayTeamId: 'tB' },
      {
        t: 'ADD_EVENT',
        id: 'z1',
        now: 4001,
        leagueId: 'lg',
        gameId: 'g2',
        teamId: 'tA',
        playerId: 'p1',
        type: 'ft_make',
        period: 1,
      },
    ]);
    const after = reduce(two.state, { t: 'UNDO_EVENT', leagueId: 'lg', gameId: 'g1' });
    expect(after.ops).toEqual([{ op: 'delete', table: 'events', id: 'e2' }]);
    expect(after.state.leagues[0]!.events.some((e) => e.id === 'z1')).toBe(true);
  });
});

describe('automatic foul-out (spec F-25)', () => {
  const fouls = (n: number): Action[] =>
    Array.from({ length: n }, (_, i) => ({
      t: 'ADD_EVENT' as const,
      id: `f${i}`,
      now: 5000 + i,
      leagueId: 'lg',
      gameId: 'g1',
      teamId: 'tA',
      playerId: 'p1',
      type: 'pf' as const,
      period: 1,
    }));

  it('leaves the player on court below the limit', () => {
    const { state } = run([...setup, ...fouls(4)]);
    expect(state.leagues[0]!.games[0]!.homeOnCourt).toEqual(['p1', 'p2']);
    expect(playerFouls(state.leagues[0]!, 'g1', 'p1')).toBe(4);
  });

  it('removes the player from the court on the fifth foul and pushes the game row', () => {
    const { state, ops } = run([...setup, ...fouls(5)]);
    expect(state.leagues[0]!.games[0]!.homeOnCourt).toEqual(['p2']);
    const lastTwo = ops.slice(-2);
    expect(lastTwo[0]).toMatchObject({ op: 'insert', table: 'events' });
    expect(lastTwo[1]).toMatchObject({ op: 'upsert', table: 'games' });
    expect(rowOf(lastTwo[1]).home_on_court).toEqual(['p2']);
  });

  it('respects a league that plays NBA rules', () => {
    const nba: Action[] = [
      { t: 'ADD_LEAGUE', id: 'lg', now: 1000, name: 'NBA Rules', season: 'S', foulOutLimit: 6 },
      ...setup.slice(1),
    ];
    const five = run([...nba, ...fouls(5)]);
    expect(five.state.leagues[0]!.games[0]!.homeOnCourt).toEqual(['p1', 'p2']);
    const six = run([...nba, ...fouls(6)]);
    expect(six.state.leagues[0]!.games[0]!.homeOnCourt).toEqual(['p2']);
  });
});

describe('unknown targets are ignored rather than throwing', () => {
  it('drops an action aimed at a league that does not exist', () => {
    const before = initialState();
    const after = reduce(before, { t: 'ADD_TEAM', id: 't', leagueId: 'nope', name: 'X' });
    expect(after.state).toBe(before);
    expect(after.ops).toEqual([]);
  });

  it('drops an event aimed at a game that does not exist', () => {
    const { state } = run(setup);
    const after = reduce(state, {
      t: 'ADD_EVENT',
      id: 'e',
      now: 1,
      leagueId: 'lg',
      gameId: 'nope',
      teamId: 'tA',
      playerId: 'p1',
      type: 'fg2_make',
      period: 1,
    });
    expect(after.ops).toEqual([]);
  });
});
