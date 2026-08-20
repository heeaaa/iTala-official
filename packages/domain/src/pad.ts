/**
 * Which stat buttons a league's tracker offers.
 *
 * This lives in the domain rather than the screen because it is a product rule,
 * not a layout decision, and because it is the rule v1 got wrong: the turnover
 * column existed in the box score with no way to produce the data, so users
 * were shown a statistic that could only ever be zero.
 */
import type { EventType, League } from './types';

export type PadSettings = Pick<League, 'trackMisses' | 'trackTurnovers'>;

const MAKES: EventType[] = ['fg2_make', 'fg3_make', 'ft_make'];
const MISSES: EventType[] = ['fg2_miss', 'fg3_miss', 'ft_miss'];
const OTHERS: EventType[] = ['reb', 'ast', 'stl', 'blk', 'pf'];

export function statPad(league: PadSettings): EventType[] {
  return [
    ...MAKES,
    ...(league.trackMisses ? MISSES : []),
    ...OTHERS,
    ...(league.trackTurnovers ? (['tov'] as EventType[]) : []),
  ];
}

/**
 * Whether a column should appear in the box score.
 *
 * Attempt columns are meaningless without miss tracking, and a turnover column
 * is worse than meaningless when turnovers cannot be logged.
 */
export function showsAttempts(league: PadSettings): boolean {
  return league.trackMisses;
}

export function showsTurnovers(league: PadSettings): boolean {
  return league.trackTurnovers;
}
