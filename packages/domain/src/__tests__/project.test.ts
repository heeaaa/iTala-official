import { describe, expect, it } from 'vitest';
import { initialState, reduce, type Action } from '../reducer.js';
import { project, eventFromRow, leagueFromRow, teamFromRow, type RowSet } from '../project.js';
import { gameScore, standings, teamBoxScore } from '../stats.js';
import type { AppState, Table } from '../index.js';

/**
 * Runs a script of actions and collects the rows the ops would have written,
 * exactly as the local store and the server both would.
 */
function applyScript(actions: Action[]): { state: AppState; rows: RowSet } {
  let state = initialState();
  const tables: Record<Table, Map<string, Record<string, unknown>>> = {
    leagues: new Map(),
    teams: new Map(),
    players: new Map(),
    games: new Map(),
    events: new Map(),
  };

  for (const a of actions) {
    const r = reduce(state, a);
    state = r.state;
    for (const op of r.ops) {
      if (op.op === 'delete') tables[op.table].delete(op.id);
      else tables[op.table].set(String(op.row['id']), op.row);
    }
  }

  return {
    state,
    rows: {
      leagues: [...tables.leagues.values()],
      teams: [...tables.teams.values()],
      players: [...tables.players.values()],
      games: [...tables.games.values()],
      events: [...tables.events.values()],
    },
  };
}

const script: Action[] = [
  { t: 'ADD_LEAGUE', id: 'lg', now: 1000, name: 'Sunday Run', season: 'Spring 2026' },
  { t: 'ADD_TEAM', id: 'tA', leagueId: 'lg', name: 'Riptide' },
  { t: 'ADD_TEAM', id: 'tB', leagueId: 'lg', name: 'Coastal' },
  { t: 'ADD_PLAYER', id: 'p1', leagueId: 'lg', teamId: 'tA', name: 'Ana', number: '00' },
  { t: 'ADD_PLAYER', id: 'p2', leagueId: 'lg', teamId: 'tA', name: 'Ben', number: '0' },
  { t: 'ADD_PLAYER', id: 'p3', leagueId: 'lg', teamId: 'tB', name: 'Dee' },
  { t: 'CREATE_GAME', id: 'g1', now: 2000, leagueId: 'lg', homeTeamId: 'tA', awayTeamId: 'tB' },
  { t: 'SET_LINEUP', leagueId: 'lg', gameId: 'g1', side: 'home', playerIds: ['p1', 'p2'] },
  {
    t: 'ADD_EVENT',
    id: 'e1',
    now: 3001,
    leagueId: 'lg',
    gameId: 'g1',
    teamId: 'tA',
    playerId: 'p1',
    type: 'fg3_make',
    period: 1,
  },
  {
    t: 'ADD_EVENT',
    id: 'e2',
    now: 3002,
    leagueId: 'lg',
    gameId: 'g1',
    teamId: 'tB',
    playerId: 'p3',
    type: 'fg2_make',
    period: 1,
  },
  {
    t: 'ADD_EVENT',
    id: 'e3',
    now: 3003,
    leagueId: 'lg',
    gameId: 'g1',
    teamId: 'tA',
    playerId: null,
    type: 'timeout',
    period: 1,
    note: '4:28',
  },
];

describe('rows round-trip back to the exact same state', () => {
  const { state, rows } = applyScript(script);
  const rebuilt = project(rows);

  it('reproduces the whole tree', () => {
    expect(rebuilt).toEqual(state);
  });

  it('reproduces every derived number', () => {
    const a = state.leagues[0]!;
    const b = rebuilt.leagues[0]!;
    expect(gameScore(b, b.games[0]!)).toEqual(gameScore(a, a.games[0]!));
    expect(teamBoxScore(b, 'g1', 'tA')).toEqual(teamBoxScore(a, 'g1', 'tA'));
    expect(standings(b)).toEqual(standings(a));
  });

  it('preserves jersey numbers as strings, so 00 stays 00', () => {
    const players = rebuilt.leagues[0]!.players;
    expect(players.map((p) => p.number)).toEqual(['00', '0', null]);
  });

  it('preserves the team-level event with a null player id', () => {
    const ev = rebuilt.leagues[0]!.events.find((e) => e.id === 'e3')!;
    expect(ev.playerId).toBeNull();
    expect(ev.note).toBe('4:28');
  });

  it('preserves roster order, which is the default starting five', () => {
    expect(rebuilt.leagues[0]!.teams[0]!.playerIds).toEqual(['p1', 'p2']);
  });
});

describe('rows from outside are validated, not cast (v1 cast blindly)', () => {
  it('drops an event whose type is not recognised', () => {
    expect(
      eventFromRow({
        id: 'x',
        league_id: 'lg',
        game_id: 'g',
        team_id: 't',
        type: 'oreb',
        period: 1,
        ts: 1,
      }),
    ).toBeNull();
    expect(
      eventFromRow({
        id: 'x',
        league_id: 'lg',
        game_id: 'g',
        team_id: 't',
        type: 'something_from_the_future',
        period: 1,
        ts: 1,
      }),
    ).toBeNull();
  });

  it('drops a row missing a required field instead of building a broken object', () => {
    expect(leagueFromRow({ name: 'no id', season: 'S' })).toBeNull();
    expect(teamFromRow({ id: 't', name: 'no league' })).toBeNull();
  });

  it('keeps false as false rather than turning it into undefined', () => {
    const l = leagueFromRow({
      id: 'lg',
      name: 'L',
      season: 'S',
      track_misses: false,
      track_turnovers: false,
      created_at: 1,
    })!;
    expect(l.trackMisses).toBe(false);
    expect(l.trackTurnovers).toBe(false);
  });

  it('falls back to FIBA rules when the league predates the column', () => {
    const l = leagueFromRow({ id: 'lg', name: 'L', season: 'S', created_at: 1 })!;
    expect(l.foulOutLimit).toBe(5);
    expect(l.regulationPeriods).toBe(4);
    expect(l.trackMisses).toBe(true);
  });

  it('drops a child whose league is not in the same pull', () => {
    const out = project({
      leagues: [],
      teams: [{ id: 't', league_id: 'missing', name: 'Orphan', color: '#fff' }],
      players: [],
      games: [],
      events: [],
    });
    expect(out.leagues).toEqual([]);
  });
});
