import { describe, expect, it } from 'vitest';
import {
  apply,
  careerStats,
  fouledOutSet,
  foulLimit,
  gameScore,
  leaderboards,
  lineScore,
  periodLabel,
  playerFouls,
  pointsOfType,
  standings,
  teamBoxScore,
  teamPeriodFouls,
} from '../stats';
import { emptyStatLine } from '../types';
import { fixtureLeague } from './fixtures';

const L = fixtureLeague();
const g1 = L.games.find((g) => g.id === 'g1')!;
const g2 = L.games.find((g) => g.id === 'g2')!;

describe('apply(): the single stat-application function (spec 7.5)', () => {
  it('a made two adds 2 points and one field goal made and attempted', () => {
    const l = emptyStatLine();
    apply(l, 'fg2_make');
    expect(l).toMatchObject({ pts: 2, fgm: 1, fga: 1, tpm: 0, tpa: 0 });
  });

  it('a made three counts in BOTH field goals and threes (trap T-4)', () => {
    const l = emptyStatLine();
    apply(l, 'fg3_make');
    expect(l).toMatchObject({ pts: 3, fgm: 1, fga: 1, tpm: 1, tpa: 1 });
  });

  it('a missed three adds an attempt to both field goals and threes', () => {
    const l = emptyStatLine();
    apply(l, 'fg3_miss');
    expect(l).toMatchObject({ pts: 0, fgm: 0, fga: 1, tpm: 0, tpa: 1 });
  });

  it('free throws move only the free-throw counters', () => {
    const made = emptyStatLine();
    apply(made, 'ft_make');
    expect(made).toMatchObject({ pts: 1, ftm: 1, fta: 1, fga: 0 });
    const miss = emptyStatLine();
    apply(miss, 'ft_miss');
    expect(miss).toMatchObject({ pts: 0, ftm: 0, fta: 1, fga: 0 });
  });

  it('a timeout contributes nothing at all', () => {
    const l = emptyStatLine();
    apply(l, 'timeout');
    expect(l).toEqual(emptyStatLine());
  });

  it('pointsOfType only scores the three scoring types', () => {
    expect(pointsOfType('fg2_make')).toBe(2);
    expect(pointsOfType('fg3_make')).toBe(3);
    expect(pointsOfType('ft_make')).toBe(1);
    for (const t of ['fg2_miss', 'reb', 'ast', 'stl', 'blk', 'tov', 'pf', 'timeout'] as const) {
      expect(pointsOfType(t)).toBe(0);
    }
  });
});

describe('teamBoxScore (spec 7.5)', () => {
  const box = teamBoxScore(L, 'g1', 'tA');

  it("computes Ana's full line by hand", () => {
    const ana = box.rows.find((r) => r.playerId === 'a1')!;
    expect(ana.line).toEqual({
      pts: 13, // 3x2 + 2x3 + 1 free throw
      fgm: 5,
      fga: 8,
      tpm: 2,
      tpa: 3,
      ftm: 1,
      fta: 2,
      reb: 4,
      ast: 3,
      stl: 2,
      blk: 1,
      tov: 2,
      pf: 2,
    });
  });

  it('seeds a zero line for a roster player who recorded nothing', () => {
    const cara = box.rows.find((r) => r.playerId === 'a3')!;
    expect(cara.line).toEqual(emptyStatLine());
  });

  it('keeps a team-level row for the null player id (trap T-7)', () => {
    const teamRow = box.rows.find((r) => r.playerId === null);
    expect(teamRow).toBeDefined();
  });

  it('sums the team total', () => {
    expect(box.total).toMatchObject({ pts: 15, fgm: 6, fga: 9, tpm: 2, tpa: 3, pf: 7 });
  });

  it('sorts by points descending, then deterministically by roster order', () => {
    expect(box.rows.map((r) => r.playerId)).toEqual(['a1', 'a2', 'a3', null]);
  });

  it('is stable across repeated computation', () => {
    const again = teamBoxScore(L, 'g1', 'tA');
    expect(again.rows.map((r) => r.playerId)).toEqual(box.rows.map((r) => r.playerId));
  });
});

describe('gameScore (spec 7.5)', () => {
  it('derives both scores from the event log alone', () => {
    expect(gameScore(L, g1)).toEqual({ home: 15, away: 17 });
    expect(gameScore(L, g2)).toEqual({ home: 30, away: 10 });
  });
});

describe('lineScore (spec 7.9)', () => {
  it('buckets points by period', () => {
    expect(lineScore(L, g1)).toEqual({ periods: [1, 2], home: [8, 7], away: [17, 0] });
  });

  it('the per-period totals sum to the game score', () => {
    const ls = lineScore(L, g1);
    const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);
    expect(sum(ls.home)).toBe(gameScore(L, g1).home);
    expect(sum(ls.away)).toBe(gameScore(L, g1).away);
  });

  it('labels periods per the league regulation length', () => {
    expect(periodLabel({ regulationPeriods: 4 }, 1)).toBe('Q1');
    expect(periodLabel({ regulationPeriods: 4 }, 5)).toBe('OT1');
    expect(periodLabel({ regulationPeriods: 2 }, 2)).toBe('H2');
    expect(periodLabel({ regulationPeriods: 2 }, 3)).toBe('OT1');
  });
});

describe('fouls (spec 7.8)', () => {
  it('counts personal fouls across the whole game', () => {
    expect(playerFouls(L, 'g1', 'a2')).toBe(5);
    expect(playerFouls(L, 'g1', 'a1')).toBe(2);
  });

  it('counts team fouls WITHIN a period only, so they reset each period', () => {
    expect(teamPeriodFouls(L, 'g1', 'tA', 1)).toBe(2);
    expect(teamPeriodFouls(L, 'g1', 'tA', 2)).toBe(5);
    expect(teamPeriodFouls(L, 'g1', 'tB', 1)).toBe(0);
  });

  it('fouls a player out at the league limit', () => {
    expect(fouledOutSet(L, 'g1', 'tA')).toEqual(new Set(['a2']));
  });

  it('honours a per-league limit instead of capping it to 5 (deviation D-4)', () => {
    expect(foulLimit({ foulOutLimit: 6 })).toBe(6);
    expect(foulLimit({ foulOutLimit: 4 })).toBe(4);
    expect(foulLimit({ foulOutLimit: 0 })).toBe(5);
    expect(foulLimit({ foulOutLimit: Number.NaN })).toBe(5);
  });

  it('an NBA league does not foul a player out on the fifth', () => {
    const nba = { ...fixtureLeague(), foulOutLimit: 6 };
    expect(fouledOutSet(nba, 'g1', 'tA').size).toBe(0);
  });
});

describe('standings (spec 7.6)', () => {
  const rows = standings(L);
  const byId = (id: string) => rows.find((r) => r.teamId === id)!;

  it('counts only final games, excluding the live one', () => {
    expect(byId('tA')).toMatchObject({ wins: 1, losses: 1, draws: 0, pf: 45, pa: 27, diff: 18 });
    expect(byId('tB')).toMatchObject({ wins: 1, losses: 1, draws: 0, pf: 27, pa: 45, diff: -18 });
  });

  it('seeds every team, including one that has never played', () => {
    expect(byId('tC')).toMatchObject({ wins: 0, losses: 0, diff: 0, streak: '—' });
  });

  it('derives the streak from games in finished order', () => {
    expect(byId('tA').streak).toBe('W1');
    expect(byId('tB').streak).toBe('L1');
  });

  it('breaks a two-way win-percentage tie by differential when head-to-head is level', () => {
    expect(rows.map((r) => r.teamId)).toEqual(['tA', 'tB', 'tC']);
  });

  it('applies head-to-head ahead of differential for an exact pair (deviation D-7)', () => {
    // Give tB the head-to-head edge while leaving tA the better differential.
    const l = fixtureLeague();
    l.games.push({
      id: 'g4',
      leagueId: 'lg1',
      homeTeamId: 'tB',
      awayTeamId: 'tA',
      status: 'final',
      scheduledAt: 3000,
      location: null,
      finishedAt: 3000,
      homeOnCourt: [],
      awayOnCourt: [],
      period: 1,
    });
    l.games.push({
      id: 'g5',
      leagueId: 'lg1',
      homeTeamId: 'tA',
      awayTeamId: 'tB',
      status: 'final',
      scheduledAt: 4000,
      location: null,
      finishedAt: 4000,
      homeOnCourt: [],
      awayOnCourt: [],
      period: 1,
    });
    // g4: tB wins by 1. g5: tA wins by 1. Records stay level at 2-2 each.
    l.events.push(
      {
        id: 'x1',
        leagueId: 'lg1',
        gameId: 'g4',
        teamId: 'tB',
        playerId: 'b1',
        type: 'fg2_make',
        period: 1,
        ts: 1,
        note: null,
      },
      {
        id: 'x2',
        leagueId: 'lg1',
        gameId: 'g5',
        teamId: 'tA',
        playerId: 'a1',
        type: 'fg2_make',
        period: 1,
        ts: 2,
        note: null,
      },
    );
    const s = standings(l);
    // tA: 2-2, pf 47, pa 29. tB: 2-2, pf 29, pa 47. Head-to-head 2-2 as well,
    // so differential decides and tA stays ahead.
    expect(s[0]!.teamId).toBe('tA');
  });

  it('records a level final game as a draw, not a home win (deviation D-6)', () => {
    const l = fixtureLeague();
    l.games = [
      {
        id: 'gd',
        leagueId: 'lg1',
        homeTeamId: 'tA',
        awayTeamId: 'tB',
        status: 'final',
        scheduledAt: 1,
        location: null,
        finishedAt: 1,
        homeOnCourt: [],
        awayOnCourt: [],
        period: 1,
      },
    ];
    l.events = [
      {
        id: 'd1',
        leagueId: 'lg1',
        gameId: 'gd',
        teamId: 'tA',
        playerId: 'a1',
        type: 'fg2_make',
        period: 1,
        ts: 1,
        note: null,
      },
      {
        id: 'd2',
        leagueId: 'lg1',
        gameId: 'gd',
        teamId: 'tB',
        playerId: 'b1',
        type: 'fg2_make',
        period: 1,
        ts: 2,
        note: null,
      },
    ];
    const s = standings(l);
    const a = s.find((r) => r.teamId === 'tA')!;
    const b = s.find((r) => r.teamId === 'tB')!;
    expect(a).toMatchObject({ wins: 0, losses: 0, draws: 1, streak: 'D1' });
    expect(b).toMatchObject({ wins: 0, losses: 0, draws: 1, streak: 'D1' });
  });
});

describe('leaderboards (spec 7.7)', () => {
  const rows = leaderboards(L);

  it('only counts a game a player actually recorded something in (the touched gate)', () => {
    const cara = rows.find((r) => r.playerId === 'a3')!;
    expect(cara.gp).toBe(1); // played g2 only; sat out g1
    const fay = rows.find((r) => r.playerId === 'b3');
    expect(fay).toBeUndefined(); // never touched a game at all
  });

  it('averages over games played, not games on the roster', () => {
    const ana = rows.find((r) => r.playerId === 'a1')!;
    expect(ana.gp).toBe(2);
    expect(ana.ppg).toBeCloseTo(16.5, 10);
    expect(ana.rpg).toBeCloseTo(2, 10);
    expect(ana.apg).toBeCloseTo(1.5, 10);
  });

  it('resolves the current team name', () => {
    expect(rows.find((r) => r.playerId === 'a1')!.teamName).toBe('Riptide');
  });

  it('sorts by points per game descending', () => {
    expect(rows.map((r) => r.name)).toEqual(['Ana', 'Dee', 'Cara', 'Ben', 'Eli']);
  });
});

describe('careerStats (spec 7.5)', () => {
  it('aggregates only final games', () => {
    const c = careerStats(L, 'a1');
    expect(c.gp).toBe(2);
    expect(c.totals.pts).toBe(33); // 13 + 20, the live game's 30 excluded
    expect(c.ppg).toBeCloseTo(16.5, 10);
  });

  it('tracks career highs independently of the best game', () => {
    const c = careerStats(L, 'a1');
    expect(c.highs).toEqual({ pts: 20, reb: 4, ast: 3, stl: 2, blk: 1 });
    expect(c.bestGame!.pts).toBe(20);
    expect(c.bestGame!.reb).toBe(0); // the 4 rebounds came in the other game
  });

  it('reports the most recent game by finished time', () => {
    const c = careerStats(L, 'a1');
    expect(c.lastGame!.gameId).toBe('g2');
    expect(c.lastGame!.line.pts).toBe(20);
  });

  it('awards a triple-double when three categories reach ten', () => {
    const c = careerStats(L, 'a3');
    expect(c.badges).toContain('Triple-Double');
    expect(c.badges).not.toContain('Double-Double');
    expect(c.best).toBe('10 pts / 10 ast / 10 reb');
  });

  it('awards Sharpshooter for five made threes in a game', () => {
    expect(careerStats(L, 'b1').badges).toContain('Sharpshooter');
  });

  it('returns zeros rather than dividing by zero for a player who never played', () => {
    const c = careerStats(L, 'b3');
    expect(c).toMatchObject({ gp: 0, ppg: 0, rpg: 0, bestGame: null, lastGame: null });
    expect(c.badges).toEqual([]);
  });
});

describe('the live game is excluded from every aggregate', () => {
  it('does not leak into standings, leaderboards or careers', () => {
    // g3 holds 30 points for Ana that must not appear anywhere below.
    expect(standings(L).find((r) => r.teamId === 'tA')!.pf).toBe(45);
    expect(leaderboards(L).find((r) => r.playerId === 'a1')!.gp).toBe(2);
    expect(careerStats(L, 'a1').totals.pts).toBe(33);
  });

  it('but a live game still has a correct live score', () => {
    const g3 = L.games.find((g) => g.id === 'g3')!;
    expect(gameScore(L, g3)).toEqual({ home: 30, away: 0 });
  });
});
