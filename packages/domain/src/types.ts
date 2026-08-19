/**
 * Core data model.
 *
 * THE GOVERNING RULE, carried forward verbatim from v1 (types.ts:1):
 *   Box scores & standings are DERIVED from events, never stored as truth.
 *
 * Nothing numeric is ever persisted. Every score, box score, standing, streak
 * and career average in this app is a fold over `League.events`. If you are
 * about to add a cached `score` column, read docs/ARCHITECTURE.md first.
 */

/**
 * Every event type that can be persisted, as a permanent string contract.
 *
 * v1 also carried `oreb` and `dreb` (a rebound split that was deferred) and
 * still aggregated them defensively. v2 starts on a new database with no
 * historical rows, so they are dropped. See docs/SPEC_DEVIATIONS.md D-2.
 */
export const EVENT_TYPES = [
  'fg2_make',
  'fg2_miss',
  'fg3_make',
  'fg3_miss',
  'ft_make',
  'ft_miss',
  'reb',
  'ast',
  'stl',
  'blk',
  'tov',
  'pf',
  'timeout',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const isEventType = (v: unknown): v is EventType =>
  typeof v === 'string' && (EVENT_TYPES as readonly string[]).includes(v);

/**
 * v1 also declared `scheduled`, which nothing in the app could ever produce.
 * v2 has no scheduling feature, so the value is removed rather than left as a
 * trap. See docs/SPEC_DEVIATIONS.md D-3.
 */
export type GameStatus = 'live' | 'final';

/** `recreational` is the single container for ad-hoc drop-in games. */
export type LeagueKind = 'league' | 'recreational';

export type Side = 'home' | 'away';

export interface Player {
  id: string;
  leagueId: string;
  name: string;
  /**
   * Jersey number as a STRING, deliberately. '00' and '0' are different
   * numbers on a real roster and leading zeros must survive a round trip.
   */
  number?: string | null;
  /**
   * Reserved for a future cross-league person identity. Nothing reads it yet.
   * The column exists now because adding it later is expensive.
   */
  personId?: string | null;
  /** Soft delete. History keeps resolving the name; pickers hide the row. */
  deletedAt?: number | null;
}

export interface Team {
  id: string;
  leagueId: string;
  name: string;
  /** Hex string from the 8-entry palette, assigned by insertion order. */
  color: string;
  /** URL into Supabase Storage. v1 stored base64 data URIs inline; v2 does not. */
  logoUrl?: string | null;
  /** ORDERED. This is the roster display order and the default starting five. */
  playerIds: string[];
  /** Drop-in teams are archived N days after their last game and hidden from rosters. */
  archivedAt?: number | null;
  deletedAt?: number | null;
}

export interface Game {
  id: string;
  leagueId: string;
  homeTeamId: string;
  awayTeamId: string;
  status: GameStatus;
  scheduledAt?: number | null;
  location?: string | null;
  /** Set only on the transition to `final`. Drives standings order and streaks. */
  finishedAt?: number | null;
  /** ORDERED, max 5. Persisted on the game so it survives navigation and restarts. */
  homeOnCourt: string[];
  awayOnCourt: string[];
  /** 1..MAX_PERIOD. Stamped onto every event logged while it is current. */
  period: number;
}

/** The atomic unit of truth. Append-only, immutable once written. */
export interface GameEvent {
  id: string;
  leagueId: string;
  gameId: string;
  teamId: string;
  /**
   * `null` is MEANINGFUL, not missing: it marks a team-level event (a timeout).
   * Team-level events must still appear in team totals. Treating null as
   * "skip this row" silently loses points from the score.
   */
  playerId: string | null;
  type: EventType;
  period: number;
  /** Client epoch milliseconds at the moment of logging. */
  ts: number;
  /** Free text. Used only for the timeout time-remaining string. */
  note?: string | null;
}

export interface League {
  id: string;
  name: string;
  /** A free-text label such as 'Spring 2026'. NOT a date range. */
  season: string;
  kind: LeagueKind;
  /**
   * Personal fouls before an automatic foul-out. FIBA is 5, NBA is 6.
   * v1 hard-capped this to 5 at read time to defend against legacy rows;
   * v2 has no legacy rows, so the value means what it says.
   * See docs/SPEC_DEVIATIONS.md D-4.
   */
  foulOutLimit: number;
  /** 2 halves or 4 quarters. Drives the line-score labels only. */
  regulationPeriods: 2 | 4;
  /** Shows the three miss buttons and switches box-score columns to made-attempted. */
  trackMisses: boolean;
  /** Shows the TOV button. v1 had the column and no button. */
  trackTurnovers: boolean;
  createdAt: number;
  teams: Team[];
  players: Player[];
  games: Game[];
  events: GameEvent[];
}

export interface AppState {
  leagues: League[];
}

/** One player's line in one context. 13 fields, all non-negative integers. */
export interface StatLine {
  pts: number;
  fgm: number;
  fga: number;
  tpm: number;
  tpa: number;
  ftm: number;
  fta: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
  pf: number;
}

export const emptyStatLine = (): StatLine => ({
  pts: 0,
  fgm: 0,
  fga: 0,
  tpm: 0,
  tpa: 0,
  ftm: 0,
  fta: 0,
  reb: 0,
  ast: 0,
  stl: 0,
  blk: 0,
  tov: 0,
  pf: 0,
});

export interface BoxScoreRow {
  /** `null` is the team-level row, rendered as 'Team'. */
  playerId: string | null;
  line: StatLine;
}

export interface TeamBoxScore {
  rows: BoxScoreRow[];
  total: StatLine;
}
