import { describe, expect, it } from 'vitest';
import { NO_ONE_OUT, initialState, reduce, type Action } from '../reducer';
import { fouledOutSet, standings, teamPeriodFouls } from '../stats';
import type { AppState } from '../types';

function run(actions: Action[], from: AppState = initialState()) {
  let state = from;
  const ops = [];
  for (const a of actions) {
    const r = reduce(state, a);
    state = r.state;
    ops.push(...r.ops);
  }
  return { state, ops, league: () => state.leagues[0]!, game: () => state.leagues[0]!.games[0]! };
}

const setup: Action[] = [
  { t: 'ADD_LEAGUE', id: 'lg', now: 1000, name: 'L', season: 'S' },
  { t: 'ADD_TEAM', id: 'tA', leagueId: 'lg', name: 'Riptide' },
  { t: 'ADD_TEAM', id: 'tB', leagueId: 'lg', name: 'Coastal' },
  ...['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'].map((id): Action => ({
    t: 'ADD_PLAYER',
    id,
    leagueId: 'lg',
    teamId: 'tA',
    name: id.toUpperCase(),
  })),
  { t: 'ADD_PLAYER', id: 'q1', leagueId: 'lg', teamId: 'tB', name: 'Q1' },
  { t: 'CREATE_GAME', id: 'g1', now: 2000, leagueId: 'lg', homeTeamId: 'tA', awayTeamId: 'tB' },
  {
    t: 'SET_LINEUP',
    leagueId: 'lg',
    gameId: 'g1',
    side: 'home',
    playerIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
  },
];

describe('SUBSTITUTE (spec 7.4b, the rule that is easy to get wrong)', () => {
  it('replaces IN PLACE, preserving the row order on the tracker', () => {
    const r = run([
      ...setup,
      { t: 'SUBSTITUTE', leagueId: 'lg', gameId: 'g1', side: 'home', outId: 'p3', inId: 'p6' },
    ]);
    expect(r.game().homeOnCourt).toEqual(['p1', 'p2', 'p6', 'p4', 'p5']);
  });

  it('appends when a slot is free and nobody is coming out', () => {
    const r = run([
      ...setup,
      { t: 'SET_LINEUP', leagueId: 'lg', gameId: 'g1', side: 'home', playerIds: ['p1', 'p2'] },
      {
        t: 'SUBSTITUTE',
        leagueId: 'lg',
        gameId: 'g1',
        side: 'home',
        outId: NO_ONE_OUT,
        inId: 'p6',
      },
    ]);
    expect(r.game().homeOnCourt).toEqual(['p1', 'p2', 'p6']);
  });

  it('refuses to append past five', () => {
    const r = run([
      ...setup,
      {
        t: 'SUBSTITUTE',
        leagueId: 'lg',
        gameId: 'g1',
        side: 'home',
        outId: NO_ONE_OUT,
        inId: 'p6',
      },
    ]);
    expect(r.game().homeOnCourt).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(r.ops.filter((o) => o.table === 'games').length).toBe(2); // create + lineup only
  });

  it('refuses to put a player on twice', () => {
    const r = run([
      ...setup,
      { t: 'SET_LINEUP', leagueId: 'lg', gameId: 'g1', side: 'home', playerIds: ['p1', 'p2'] },
      {
        t: 'SUBSTITUTE',
        leagueId: 'lg',
        gameId: 'g1',
        side: 'home',
        outId: NO_ONE_OUT,
        inId: 'p1',
      },
    ]);
    expect(r.game().homeOnCourt).toEqual(['p1', 'p2']);
  });

  it('records NO event, so there is no substitution history or minutes played', () => {
    const r = run([
      ...setup,
      { t: 'SUBSTITUTE', leagueId: 'lg', gameId: 'g1', side: 'home', outId: 'p1', inId: 'p6' },
    ]);
    expect(r.league().events).toEqual([]);
  });
});

describe('SET_PERIOD (spec F-27)', () => {
  const advance = (n: number): Action => ({
    t: 'SET_PERIOD',
    leagueId: 'lg',
    gameId: 'g1',
    period: n,
  });

  it('clamps to 1 and to the maximum of 9', () => {
    expect(run([...setup, advance(0)]).game().period).toBe(1);
    expect(run([...setup, advance(-5)]).game().period).toBe(1);
    expect(run([...setup, advance(99)]).game().period).toBe(9);
  });

  it('emits nothing when the period is unchanged', () => {
    const before = run(setup);
    const after = reduce(before.state, advance(1));
    expect(after.ops).toEqual([]);
  });

  it('resets team fouls by changing the filter, not by clearing anything', () => {
    const foul = (id: string, period: number): Action => ({
      t: 'ADD_EVENT',
      id,
      now: 3000,
      leagueId: 'lg',
      gameId: 'g1',
      teamId: 'tA',
      playerId: 'p1',
      type: 'pf',
      period,
    });
    const r = run([...setup, foul('f1', 1), foul('f2', 1), advance(2), foul('f3', 2)]);

    expect(teamPeriodFouls(r.league(), 'g1', 'tA', 1)).toBe(2);
    expect(teamPeriodFouls(r.league(), 'g1', 'tA', 2)).toBe(1);
    // Going BACK a period restores the earlier count, which is correct for a
    // correction: nothing was ever cleared.
    const back = reduce(r.state, advance(1));
    expect(teamPeriodFouls(back.state.leagues[0]!, 'g1', 'tA', 1)).toBe(2);
  });

  it('does not reset personal fouls, which accumulate across the whole game', () => {
    const foul = (id: string, period: number): Action => ({
      t: 'ADD_EVENT',
      id,
      now: 3000,
      leagueId: 'lg',
      gameId: 'g1',
      teamId: 'tA',
      playerId: 'p1',
      type: 'pf',
      period,
    });
    const r = run([
      ...setup,
      foul('f1', 1),
      foul('f2', 1),
      advance(2),
      foul('f3', 2),
      foul('f4', 2),
      advance(3),
      foul('f5', 3),
    ]);
    expect(fouledOutSet(r.league(), 'g1', 'tA')).toEqual(new Set(['p1']));
  });
});

describe('SET_GAME_STATUS (spec F-29)', () => {
  const finish = (now: number): Action => ({
    t: 'SET_GAME_STATUS',
    leagueId: 'lg',
    gameId: 'g1',
    now,
    status: 'final',
  });

  it('stamps finishedAt on the transition into final', () => {
    const r = run([...setup, finish(9999)]);
    expect(r.game().status).toBe('final');
    expect(r.game().finishedAt).toBe(9999);
  });

  it('unlocks the game for standings the moment it is final', () => {
    const score: Action = {
      t: 'ADD_EVENT',
      id: 'e1',
      now: 3000,
      leagueId: 'lg',
      gameId: 'g1',
      teamId: 'tA',
      playerId: 'p1',
      type: 'fg2_make',
      period: 1,
    };
    const live = run([...setup, score]);
    expect(standings(live.league()).find((s) => s.teamId === 'tA')!.wins).toBe(0);

    const done = run([...setup, score, finish(9999)]);
    expect(standings(done.league()).find((s) => s.teamId === 'tA')!.wins).toBe(1);
    expect(standings(done.league()).find((s) => s.teamId === 'tB')!.losses).toBe(1);
  });

  it('keeps the original finish time when a game is reopened and finished again', () => {
    const r = run([
      ...setup,
      finish(9999),
      { t: 'SET_GAME_STATUS', leagueId: 'lg', gameId: 'g1', now: 20000, status: 'live' },
      finish(30000),
    ]);
    // Standings order depends on finishedAt, so it must not shuffle because
    // somebody corrected a box score a week later.
    expect(r.game().finishedAt).toBe(9999);
    expect(r.game().status).toBe('final');
  });
});

describe('UPDATE_LEAGUE_SETTINGS (deviation D-9: per league, not global)', () => {
  it('changes only what was passed', () => {
    const r = run([
      ...setup,
      { t: 'UPDATE_LEAGUE_SETTINGS', leagueId: 'lg', trackTurnovers: true },
    ]);
    expect(r.league().trackTurnovers).toBe(true);
    expect(r.league().trackMisses).toBe(true);
    expect(r.league().foulOutLimit).toBe(5);
  });

  it('lets one league run NBA rules while another runs FIBA', () => {
    const r = run([
      ...setup,
      { t: 'ADD_LEAGUE', id: 'lg2', now: 1, name: 'Other', season: 'S' },
      { t: 'UPDATE_LEAGUE_SETTINGS', leagueId: 'lg', foulOutLimit: 6, regulationPeriods: 2 },
    ]);
    const byId = (id: string) => r.state.leagues.find((l) => l.id === id)!;
    expect(byId('lg').foulOutLimit).toBe(6);
    expect(byId('lg').regulationPeriods).toBe(2);
    expect(byId('lg2').foulOutLimit).toBe(5);
    expect(byId('lg2').regulationPeriods).toBe(4);
  });

  it('pushes the whole league row so the change reaches other devices', () => {
    const before = run(setup);
    const after = reduce(before.state, {
      t: 'UPDATE_LEAGUE_SETTINGS',
      leagueId: 'lg',
      trackMisses: false,
    });
    expect(after.ops).toHaveLength(1);
    const op = after.ops[0]!;
    expect(op.op).toBe('upsert');
    expect(op.table).toBe('leagues');
  });
});
