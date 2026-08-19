/**
 * A fixed, hand-verifiable league used by the golden tests.
 *
 * Every number asserted in the suite was worked out by hand from this data
 * against the rules in APP_CONTEXT_UPDATED.md section 7, NOT by running the
 * code and recording what it produced. That is the whole point: these tests
 * are the spec made executable.
 */
import type { EventType, Game, GameEvent, League, Player, Team } from '../types.js';

type EvSpec = [
  period: number,
  teamId: string,
  playerId: string | null,
  type: EventType,
  n?: number,
];

const player = (id: string, name: string, number: string): Player => ({
  id,
  leagueId: 'lg1',
  name,
  number,
  personId: null,
  deletedAt: null,
});

const team = (id: string, name: string, color: string, playerIds: string[]): Team => ({
  id,
  leagueId: 'lg1',
  name,
  color,
  logoUrl: null,
  playerIds,
  archivedAt: null,
  deletedAt: null,
});

const game = (id: string, status: Game['status'], finishedAt: number | null, period = 1): Game => ({
  id,
  leagueId: 'lg1',
  homeTeamId: 'tA',
  awayTeamId: 'tB',
  status,
  scheduledAt: finishedAt ? finishedAt - 500 : 5000,
  location: 'Main Gym',
  finishedAt,
  homeOnCourt: ['a1', 'a2', 'a3'],
  awayOnCourt: ['b1', 'b2', 'b3'],
  period,
});

function expand(gameId: string, specs: EvSpec[]): GameEvent[] {
  const out: GameEvent[] = [];
  let seq = 0;
  for (const [period, teamId, playerId, type, n = 1] of specs) {
    for (let i = 0; i < n; i++) {
      seq++;
      out.push({
        id: `${gameId}-e${String(seq).padStart(3, '0')}`,
        leagueId: 'lg1',
        gameId,
        teamId,
        playerId,
        type,
        period,
        ts: 1_000_000 + seq,
        note: type === 'timeout' ? '4:28' : null,
      });
    }
  }
  return out;
}

/* --- Game 1: away team wins 17-15, and a2 fouls out in period 2 ----------- */
const g1Events = expand('g1', [
  [1, 'tA', 'a1', 'fg2_make', 3],
  [1, 'tA', 'a1', 'fg2_miss', 2],
  [1, 'tA', 'a2', 'fg2_make', 1],
  [1, 'tB', 'b1', 'fg3_make', 3],
  [1, 'tB', 'b2', 'fg2_make', 1],
  [1, 'tA', 'a2', 'pf', 2],
  [1, 'tB', 'b1', 'fg3_make', 2],
  [2, 'tA', 'a1', 'fg3_make', 2],
  [2, 'tA', 'a1', 'fg3_miss', 1],
  [2, 'tA', 'a1', 'ft_make', 1],
  [2, 'tA', 'a1', 'ft_miss', 1],
  [2, 'tA', 'a1', 'reb', 4],
  [2, 'tA', 'a1', 'ast', 3],
  [2, 'tA', 'a1', 'stl', 2],
  [2, 'tA', 'a1', 'blk', 1],
  [2, 'tA', 'a1', 'tov', 2],
  [2, 'tA', 'a1', 'pf', 2],
  [2, 'tA', 'a2', 'pf', 3],
  [2, 'tA', null, 'timeout', 1],
]);

/* --- Game 2: home team wins 30-10, a3 records a triple-double -------------- */
const g2Events = expand('g2', [
  [1, 'tA', 'a1', 'fg2_make', 10],
  [1, 'tA', 'a3', 'fg2_make', 5],
  [1, 'tA', 'a3', 'reb', 10],
  [1, 'tA', 'a3', 'ast', 10],
  [1, 'tB', 'b1', 'fg2_make', 5],
]);

/* --- Game 3: still live. Must be excluded from every aggregate ------------- */
const g3Events = expand('g3', [[1, 'tA', 'a1', 'fg3_make', 10]]);

export const fixtureLeague = (): League => ({
  id: 'lg1',
  name: 'Test League',
  season: 'Spring 2026',
  kind: 'league',
  foulOutLimit: 5,
  regulationPeriods: 4,
  trackMisses: true,
  trackTurnovers: true,
  createdAt: 1000,
  players: [
    player('a1', 'Ana', '7'),
    player('a2', 'Ben', '23'),
    player('a3', 'Cara', '4'),
    player('b1', 'Dee', '11'),
    player('b2', 'Eli', '00'),
    player('b3', 'Fay', '0'),
  ],
  teams: [
    team('tA', 'Riptide', '#3A78FF', ['a1', 'a2', 'a3']),
    team('tB', 'Coastal', '#FF6B6B', ['b1', 'b2', 'b3']),
    team('tC', 'Northside', '#9B59FF', []),
  ],
  games: [game('g1', 'final', 1000), game('g2', 'final', 2000), game('g3', 'live', null)],
  events: [...g1Events, ...g2Events, ...g3Events],
});
