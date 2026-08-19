/**
 * ALL derivation logic. Pure functions over the event log, no dependencies.
 *
 * This file is the single most important thing in the codebase to get right:
 * every number the user ever sees comes out of here. It is also the easiest
 * thing to test, which is why the golden suite in __tests__ exists and why it
 * was written before this file.
 */
import { DEFAULT_FOUL_OUT, NO_VALUE } from './constants.js';
import type {
  EventType,
  Game,
  GameEvent,
  League,
  Player,
  StatLine,
  Team,
  TeamBoxScore,
} from './types.js';
import { emptyStatLine } from './types.js';

/* -------------------------------------------------------------------------- */
/* Foul rules                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Personal fouls before an automatic foul-out.
 *
 * v1 capped any stored value above 5 down to 5, to defend against leagues
 * written by an older version that saved 6. v2 starts clean, so the stored
 * value is honoured and a league can legitimately run NBA rules.
 * A missing or nonsensical value falls back to FIBA 5.
 */
export function foulLimit(league: Pick<League, 'foulOutLimit'>): number {
  const stored = league.foulOutLimit;
  if (!Number.isFinite(stored) || stored < 1) return DEFAULT_FOUL_OUT;
  return Math.floor(stored);
}

/* -------------------------------------------------------------------------- */
/* The single stat-application function                                        */
/* -------------------------------------------------------------------------- */

/**
 * Everything numeric in the app routes through this switch.
 *
 * Two rules encoded here that are easy to get wrong and that nobody notices
 * for months:
 *
 *  - A made three increments FG *and* 3P. fgm, fga, tpm and tpa all rise, so
 *    FG% is all-shots percentage, which is standard basketball convention.
 *  - `timeout` has no case and contributes nothing. It falls through on purpose.
 */
export function apply(line: StatLine, type: EventType): void {
  switch (type) {
    case 'fg2_make':
      line.pts += 2;
      line.fgm++;
      line.fga++;
      break;
    case 'fg2_miss':
      line.fga++;
      break;
    case 'fg3_make':
      line.pts += 3;
      line.fgm++;
      line.fga++;
      line.tpm++;
      line.tpa++;
      break;
    case 'fg3_miss':
      line.fga++;
      line.tpa++;
      break;
    case 'ft_make':
      line.pts += 1;
      line.ftm++;
      line.fta++;
      break;
    case 'ft_miss':
      line.fta++;
      break;
    case 'reb':
      line.reb++;
      break;
    case 'ast':
      line.ast++;
      break;
    case 'stl':
      line.stl++;
      break;
    case 'blk':
      line.blk++;
      break;
    case 'tov':
      line.tov++;
      break;
    case 'pf':
      line.pf++;
      break;
    case 'timeout':
      break;
  }
}

export function pointsOfType(type: EventType): number {
  if (type === 'fg2_make') return 2;
  if (type === 'fg3_make') return 3;
  if (type === 'ft_make') return 1;
  return 0;
}

function addInto(target: StatLine, src: StatLine): void {
  target.pts += src.pts;
  target.fgm += src.fgm;
  target.fga += src.fga;
  target.tpm += src.tpm;
  target.tpa += src.tpa;
  target.ftm += src.ftm;
  target.fta += src.fta;
  target.reb += src.reb;
  target.ast += src.ast;
  target.stl += src.stl;
  target.blk += src.blk;
  target.tov += src.tov;
  target.pf += src.pf;
}

/* -------------------------------------------------------------------------- */
/* Lookups                                                                     */
/* -------------------------------------------------------------------------- */

export const findTeam = (league: League, teamId: string): Team | undefined =>
  league.teams.find((t) => t.id === teamId);

export const findPlayer = (league: League, playerId: string): Player | undefined =>
  league.players.find((p) => p.id === playerId);

export const findGame = (league: League, gameId: string): Game | undefined =>
  league.games.find((g) => g.id === gameId);

/** Teams that still exist. Soft-deleted teams stay in history but not in lists. */
export const liveTeams = (league: League): Team[] => league.teams.filter((t) => !t.deletedAt);

/** The team a player currently belongs to, or undefined for a free agent. */
export const teamOfPlayer = (league: League, playerId: string): Team | undefined =>
  liveTeams(league).find((t) => t.playerIds.includes(playerId));

/* -------------------------------------------------------------------------- */
/* Box score                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One team's stat table for one game, plus the team total.
 *
 * Roster players with no events are seeded with a zero line so they still
 * appear. A player who has left the team but has events still gets a row,
 * created by the event rather than the seed.
 *
 * Sorting: points descending. v1 stopped there, which left players on equal
 * points free to swap places between renders. v2 breaks the tie by roster
 * order and then by id, so the table is stable.
 * See docs/SPEC_DEVIATIONS.md D-5.
 */
export function teamBoxScore(league: League, gameId: string, teamId: string): TeamBoxScore {
  const team = findTeam(league, teamId);
  const byPlayer = new Map<string | null, StatLine>();

  if (team) {
    for (const pid of team.playerIds) byPlayer.set(pid, emptyStatLine());
  }

  for (const e of league.events) {
    if (e.gameId !== gameId || e.teamId !== teamId) continue;
    let line = byPlayer.get(e.playerId);
    if (!line) {
      line = emptyStatLine();
      byPlayer.set(e.playerId, line);
    }
    apply(line, e.type);
  }

  const rosterIndex = new Map<string, number>();
  team?.playerIds.forEach((pid, i) => rosterIndex.set(pid, i));
  const orderOf = (pid: string | null): number =>
    pid === null ? Number.MAX_SAFE_INTEGER : (rosterIndex.get(pid) ?? Number.MAX_SAFE_INTEGER - 1);

  const rows = [...byPlayer.entries()]
    .map(([playerId, line]) => ({ playerId, line }))
    .sort((a, b) => {
      if (b.line.pts !== a.line.pts) return b.line.pts - a.line.pts;
      const oa = orderOf(a.playerId);
      const ob = orderOf(b.playerId);
      if (oa !== ob) return oa - ob;
      return String(a.playerId).localeCompare(String(b.playerId));
    });

  const total = emptyStatLine();
  for (const r of rows) addInto(total, r.line);

  return { rows, total };
}

export interface GameScore {
  home: number;
  away: number;
}

export function gameScore(league: League, game: Game): GameScore {
  return {
    home: teamBoxScore(league, game.id, game.homeTeamId).total.pts,
    away: teamBoxScore(league, game.id, game.awayTeamId).total.pts,
  };
}

/* -------------------------------------------------------------------------- */
/* Line score                                                                  */
/* -------------------------------------------------------------------------- */

export interface LineScore {
  periods: number[];
  home: number[];
  away: number[];
}

/**
 * Points per period.
 *
 * The period range runs from 1 to the highest period any event was logged in,
 * so a scoreless quarter still appears as long as a later one has events. A
 * game sitting in period 4 with nothing logged there shows only Q1 to Q3, which
 * matches v1 exactly.
 */
export function lineScore(league: League, game: Game): LineScore {
  let maxP = 1;
  for (const e of league.events) {
    if (e.gameId === game.id && e.period > maxP) maxP = e.period;
  }
  const periods = Array.from({ length: maxP }, (_, i) => i + 1);
  const home = new Array<number>(maxP).fill(0);
  const away = new Array<number>(maxP).fill(0);

  for (const e of league.events) {
    if (e.gameId !== game.id) continue;
    const pts = pointsOfType(e.type);
    if (pts === 0) continue;
    const idx = e.period - 1;
    if (idx < 0 || idx >= maxP) continue;
    if (e.teamId === game.homeTeamId) home[idx] = (home[idx] ?? 0) + pts;
    else if (e.teamId === game.awayTeamId) away[idx] = (away[idx] ?? 0) + pts;
  }

  return { periods, home, away };
}

/** 'Q1'..'Q4' then 'OT1', or 'H1'/'H2' then 'OT1', depending on the league. */
export function periodLabel(league: Pick<League, 'regulationPeriods'>, period: number): string {
  const reg = league.regulationPeriods;
  if (period <= reg) return reg === 2 ? `H${period}` : `Q${period}`;
  return `OT${period - reg}`;
}

/* -------------------------------------------------------------------------- */
/* Fouls                                                                       */
/* -------------------------------------------------------------------------- */

/** Personal fouls for one player across a whole game. Drives foul-out. */
export function playerFouls(league: League, gameId: string, playerId: string): number {
  let n = 0;
  for (const e of league.events) {
    if (e.gameId === gameId && e.playerId === playerId && e.type === 'pf') n++;
  }
  return n;
}

/**
 * Team fouls WITHIN ONE PERIOD. The reset at the end of a quarter is emergent:
 * advancing the period changes the filter, so the number drops to zero by
 * itself. Personal fouls do not reset. Same event type, different scope.
 */
export function teamPeriodFouls(
  league: League,
  gameId: string,
  teamId: string,
  period: number,
): number {
  let n = 0;
  for (const e of league.events) {
    if (e.gameId === gameId && e.teamId === teamId && e.type === 'pf' && e.period === period) n++;
  }
  return n;
}

/** Players on the current roster who have reached the league's foul limit. */
export function fouledOutSet(league: League, gameId: string, teamId: string): Set<string> {
  const limit = foulLimit(league);
  const team = findTeam(league, teamId);
  const out = new Set<string>();
  if (!team) return out;
  for (const pid of team.playerIds) {
    if (playerFouls(league, gameId, pid) >= limit) out.add(pid);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Standings                                                                   */
/* -------------------------------------------------------------------------- */

export type StreakMark = 'W' | 'L' | 'D';

export interface StandingRow {
  teamId: string;
  teamName: string;
  wins: number;
  losses: number;
  draws: number;
  pf: number;
  pa: number;
  diff: number;
  streak: string;
}

/** 'W3', 'L1', 'D1', or an em dash when no final game has been played. */
export function formatStreak(arr: StreakMark[]): string {
  if (arr.length === 0) return NO_VALUE;
  const last = arr[arr.length - 1] as StreakMark;
  let n = 0;
  for (let i = arr.length - 1; i >= 0 && arr[i] === last; i--) n++;
  return `${last}${n}`;
}

const winPctOf = (r: StandingRow): number => {
  const games = r.wins + r.losses + r.draws;
  return games === 0 ? 0 : (r.wins + 0.5 * r.draws) / games;
};

/**
 * Standings, computed only from games with status `final`.
 *
 * Two rules worth stating out loud:
 *
 *  - v1 recorded a tie as a HOME WIN (`s.home >= s.away`). v2 records a real
 *    draw. Basketball goes to overtime so this is rare, but silently awarding
 *    a win to whoever happens to be listed first is not defensible.
 *    See docs/SPEC_DEVIATIONS.md D-6.
 *  - Sort order is win% then head-to-head then point differential, with head-
 *    to-head applied ONLY when exactly two teams are tied on win%. Circular
 *    ties among three or more teams fall straight through to differential.
 *    See docs/SPEC_DEVIATIONS.md D-7.
 */
export function standings(league: League): StandingRow[] {
  const rows = new Map<string, StandingRow>();
  const streaks = new Map<string, StreakMark[]>();

  for (const t of liveTeams(league)) {
    rows.set(t.id, {
      teamId: t.id,
      teamName: t.name,
      wins: 0,
      losses: 0,
      draws: 0,
      pf: 0,
      pa: 0,
      diff: 0,
      streak: NO_VALUE,
    });
    streaks.set(t.id, []);
  }

  const finals = league.games
    .filter((g) => g.status === 'final')
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));

  for (const g of finals) {
    const home = rows.get(g.homeTeamId);
    const away = rows.get(g.awayTeamId);
    // A game whose team no longer exists is skipped entirely.
    if (!home || !away) continue;

    const s = gameScore(league, g);
    home.pf += s.home;
    home.pa += s.away;
    away.pf += s.away;
    away.pa += s.home;

    if (s.home > s.away) {
      home.wins++;
      away.losses++;
      streaks.get(g.homeTeamId)?.push('W');
      streaks.get(g.awayTeamId)?.push('L');
    } else if (s.away > s.home) {
      away.wins++;
      home.losses++;
      streaks.get(g.awayTeamId)?.push('W');
      streaks.get(g.homeTeamId)?.push('L');
    } else {
      home.draws++;
      away.draws++;
      streaks.get(g.homeTeamId)?.push('D');
      streaks.get(g.awayTeamId)?.push('D');
    }
  }

  const list = [...rows.values()];
  for (const r of list) {
    r.diff = r.pf - r.pa;
    r.streak = formatStreak(streaks.get(r.teamId) ?? []);
  }

  // Head-to-head is only meaningful for an exact pair, so pre-compute which
  // win-percentage buckets contain exactly two teams.
  const byPct = new Map<number, StandingRow[]>();
  for (const r of list) {
    const k = winPctOf(r);
    const bucket = byPct.get(k);
    if (bucket) bucket.push(r);
    else byPct.set(k, [r]);
  }

  return list.sort((a, b) => {
    const pa = winPctOf(a);
    const pb = winPctOf(b);
    if (pa !== pb) return pb - pa;

    const bucket = byPct.get(pa);
    if (bucket && bucket.length === 2) {
      const h2h = headToHead(league, finals, a.teamId, b.teamId);
      if (h2h !== 0) return h2h;
    }

    if (b.diff !== a.diff) return b.diff - a.diff;
    return a.teamName.localeCompare(b.teamName);
  });
}

/** Negative when A ranks ahead of B. Zero when they are level or never met. */
function headToHead(league: League, finals: Game[], aId: string, bId: string): number {
  let aWins = 0;
  let bWins = 0;
  for (const g of finals) {
    const involvesBoth =
      (g.homeTeamId === aId && g.awayTeamId === bId) ||
      (g.homeTeamId === bId && g.awayTeamId === aId);
    if (!involvesBoth) continue;
    const s = gameScore(league, g);
    const aScore = g.homeTeamId === aId ? s.home : s.away;
    const bScore = g.homeTeamId === bId ? s.home : s.away;
    if (aScore > bScore) aWins++;
    else if (bScore > aScore) bWins++;
  }
  return bWins - aWins;
}

/* -------------------------------------------------------------------------- */
/* Leaderboards                                                                */
/* -------------------------------------------------------------------------- */

export interface LeaderRow {
  playerId: string;
  name: string;
  teamName: string;
  gp: number;
  ppg: number;
  rpg: number;
  apg: number;
  spg: number;
  bpg: number;
}

/**
 * League-wide per-game averages, sorted by points per game descending.
 *
 * THE TOUCHED GATE: a player only counts as having played a game if they
 * recorded something in it. A player who sat on the bench does not get a game
 * played, so their own averages are not diluted. Miss this and every squad
 * player's numbers are silently deflated.
 */
const touched = (l: StatLine): boolean =>
  Boolean(l.pts || l.reb || l.ast || l.stl || l.blk || l.fga || l.fta || l.tov || l.pf);

export function leaderboards(league: League): LeaderRow[] {
  const acc = new Map<string, { gp: number; t: StatLine }>();
  const finals = league.games.filter((g) => g.status === 'final');

  for (const g of finals) {
    for (const teamId of [g.homeTeamId, g.awayTeamId]) {
      const box = teamBoxScore(league, g.id, teamId);
      for (const row of box.rows) {
        if (row.playerId === null) continue;
        if (!touched(row.line)) continue;
        let entry = acc.get(row.playerId);
        if (!entry) {
          entry = { gp: 0, t: emptyStatLine() };
          acc.set(row.playerId, entry);
        }
        entry.gp++;
        addInto(entry.t, row.line);
      }
    }
  }

  const out: LeaderRow[] = [];
  for (const [playerId, { gp, t }] of acc) {
    const player = findPlayer(league, playerId);
    if (!player) continue;
    out.push({
      playerId,
      name: player.name,
      teamName: teamOfPlayer(league, playerId)?.name ?? '',
      gp,
      ppg: t.pts / gp,
      rpg: t.reb / gp,
      apg: t.ast / gp,
      spg: t.stl / gp,
      bpg: t.blk / gp,
    });
  }

  return out.sort((a, b) => (b.ppg !== a.ppg ? b.ppg - a.ppg : a.name.localeCompare(b.name)));
}

/* -------------------------------------------------------------------------- */
/* Career stats                                                                */
/* -------------------------------------------------------------------------- */

export interface CareerHighs {
  pts: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
}

export interface LastGameStat {
  gameId: string;
  leagueName: string;
  ts: number;
  line: StatLine;
}

export interface CareerStats {
  gp: number;
  totals: StatLine;
  ppg: number;
  rpg: number;
  apg: number;
  spg: number;
  bpg: number;
  topg: number;
  pfpg: number;
  tpmpg: number;
  highs: CareerHighs;
  /** The single highest-scoring game line. */
  bestGame: StatLine | null;
  /** 'pts/reb/ast' style summary of bestGame, non-zero categories only. */
  best: string;
  lastGame: LastGameStat | null;
  badges: string[];
}

/**
 * A player's aggregate across every FINAL game in their one league.
 *
 * Despite the name there is no cross-league career: player identity is
 * league-scoped, so the same human in two leagues has two records.
 */
export function careerStats(league: League, playerId: string): CareerStats {
  const limit = { gp: 0 };
  const totals = emptyStatLine();
  const highs: CareerHighs = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0 };
  const badgeSet = new Set<string>();

  let bestGame: StatLine | null = null;
  let highPts = -1;
  let lastGame: LastGameStat | null = null;
  let lastGameMs = -1;

  for (const g of league.games) {
    if (g.status !== 'final') continue;
    for (const teamId of [g.homeTeamId, g.awayTeamId]) {
      const box = teamBoxScore(league, g.id, teamId);
      const row = box.rows.find((r) => r.playerId === playerId);
      if (!row) continue;
      const l = row.line;
      if (!touched(l)) continue;

      limit.gp++;
      addInto(totals, l);

      // First qualifying game always becomes the best game; after that only a
      // strictly higher points total replaces it, so ties keep the earlier one.
      if (l.pts > highPts || !bestGame) {
        highPts = l.pts;
        bestGame = { ...l };
      }

      highs.pts = Math.max(highs.pts, l.pts);
      highs.reb = Math.max(highs.reb, l.reb);
      highs.ast = Math.max(highs.ast, l.ast);
      highs.stl = Math.max(highs.stl, l.stl);
      highs.blk = Math.max(highs.blk, l.blk);

      const ms = g.finishedAt ?? g.scheduledAt ?? 0;
      if (ms >= lastGameMs) {
        lastGameMs = ms;
        lastGame = { gameId: g.id, leagueName: league.name, ts: ms, line: { ...l } };
      }

      // Badges, recomputed from scratch every time. Steals and blocks count
      // toward a double-double, which is unconventional but consistent.
      const cats = [l.pts, l.reb, l.ast, l.stl, l.blk].filter((v) => v >= 10).length;
      if (cats >= 3) badgeSet.add('Triple-Double');
      else if (cats === 2) badgeSet.add('Double-Double');
      if (l.pts >= 50) badgeSet.add('50-Burger');
      else if (l.pts >= 30) badgeSet.add('30+ Game');
      if (l.tpm >= 5) badgeSet.add('Sharpshooter');
    }
  }

  const gp = limit.gp;
  const per = (n: number): number => (gp === 0 ? 0 : n / gp);

  return {
    gp,
    totals,
    ppg: per(totals.pts),
    rpg: per(totals.reb),
    apg: per(totals.ast),
    spg: per(totals.stl),
    bpg: per(totals.blk),
    topg: per(totals.tov),
    pfpg: per(totals.pf),
    tpmpg: per(totals.tpm),
    highs,
    bestGame,
    best: bestGame ? bestNight(bestGame) : '',
    lastGame,
    badges: [...badgeSet],
  };
}

/** 'Best night' summary: only non-zero categories, in this fixed order. */
export function bestNight(l: StatLine): string {
  const parts: string[] = [];
  if (l.pts) parts.push(`${l.pts} pts`);
  if (l.ast) parts.push(`${l.ast} ast`);
  if (l.reb) parts.push(`${l.reb} reb`);
  if (l.stl) parts.push(`${l.stl} stl`);
  if (l.blk) parts.push(`${l.blk} blk`);
  return parts.join(' / ');
}

export type { GameEvent };
