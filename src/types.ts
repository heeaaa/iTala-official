// Core data model. Box scores & standings are DERIVED from events, never stored as truth.

export type EventType =
  | 'fg2_make' | 'fg2_miss'
  | 'fg3_make' | 'fg3_miss'
  | 'ft_make'  | 'ft_miss'
  | 'reb'                 // combined rebound (O/D split deferred to a later version)
  | 'oreb' | 'dreb'       // legacy split rebounds, still aggregated if present
  | 'ast' | 'stl' | 'blk'
  | 'tov'                 // legacy turnover, still aggregated if present
  | 'pf'
  | 'timeout';            // team timeout; note holds time remaining (e.g. "4:28")

export interface Player {
  id: string;
  name: string;
  number?: string; // jersey, optional
  // DORMANT BREADCRUMB — nothing reads this yet. Set only by Duplicate League
  // to remember which player this copy came from, so a future cross-league
  // career-profile feature can link seasons retroactively with zero guesswork.
  // Points at the ULTIMATE origin (chains stay flat across many seasons).
  //
  // This is LINEAGE, not identity: it means "this row was copied from that
  // row". It is NOT a grouping key for one human. A player added fresh in a
  // second league has no link to the same person elsewhere, because nothing
  // outside Duplicate League ever sets it.
  //
  // If cross-league careers get built, the open decision is whether this is
  // walked as a chain or superseded by a dedicated person id. Adding that
  // column is not the blocker (see the `alter table ... add column if not
  // exists` pattern in supabase/schema.sql, proven safe by
  // tests/sql/admin_upgrade.test.sql) — the blocker is deciding who says two
  // "J. Santos" rows are the same person, plus backfilling the answer.
  originPlayerId?: string;
}

export interface Team {
  id: string;
  name: string;
  color: string;
  playerIds: string[];
  logo?: string;      // data URI (base64) for the team logo, optional
  coach?: string;     // coach / manager name, optional
  teamOnly?: boolean; // opponent-as-team shortcut: track score only, no individual players
}

export interface GameEvent {
  id: string;
  gameId: string;
  teamId: string;
  playerId: string | null; // null = team-level (opponent-as-team)
  type: EventType;
  period: number;
  ts: number;
  note?: string; // freeform detail, e.g. timeout "time remaining"
}

export type GameStatus = 'scheduled' | 'live' | 'final';

export interface Game {
  createdBy?: string; // who started it; server-owned, drives community drop-in scoring rights
  id: string;
  leagueId: string;
  homeTeamId: string;
  awayTeamId: string;
  status: GameStatus;
  scheduledAt?: number;
  location?: string;
  finishedAt?: number;
  homeOnCourt?: string[]; // player ids currently on the floor (max 5)
  awayOnCourt?: string[];
  period?: number;
  attendance?: string[]; // player ids present at this game (undefined = not recorded)
  // Per-game stat-tracking overrides (used by drop-in games, where the shared
  // container's league-level setting can't be one user's to change).
  // undefined = inherit the league setting.
  trackMisses?: boolean;
  trackTurnovers?: boolean;        // current live period (persists across screen navigation)
}

export interface League {
  id: string;
  name: string;
  season: string;
  kind?: 'league' | 'recreational'; // 'recreational' = ad-hoc drop-in games container
  foulOutLimit?: number; // personal fouls before a player fouls out (default 6)
  trackMisses?: boolean; // per-league: show 2PT✗/3PT✗/FT✗ in the live tracker (default true)
  trackTurnovers?: boolean; // per-league: show the TOV button in the live tracker (default true)
  isShared?: boolean; // recreational only: the community drop-in space any signed-in user can write to
  isClosed?: boolean; // season officially complete — unlocks final awards (Mythical Five)
  isArchived?: boolean; // hidden everywhere; Super Admins can view/unarchive
  // Transient redo stash (per gameId) — lives only in memory, never synced or
  // saved. Populated by UNDO_EVENT, drained by REDO_EVENT, cleared by ADD_EVENT.
  _redo?: Record<string, GameEvent[]>;
  /**
   * Whether this device holds this league's teams, players, games and events -
   * as opposed to just its catalogue row.
   *
   * "No games" and "games not fetched" are different facts that look identical
   * in the arrays below, and confusing them renders a scored game as 0-0 (see
   * N-39). Absent/false means the four arrays below say nothing; a screen must
   * show a loading state rather than zeros, and nothing may conclude from their
   * emptiness that rows were deleted.
   *
   * PERSISTED deliberately: a relaunch has to know which leagues it actually
   * has on disk, or it would present a catalogue row as a fully-read league.
   */
  detailLoaded?: boolean;
  teams: Team[];
  players: Player[]; // league-scoped player pool
  games: Game[];
  events: GameEvent[];
  createdAt: number;
}

// LEGACY, read-only. An app-wide trackMisses toggle that predates
// League.trackMisses. It is no longer part of AppState and nothing writes it,
// but a device upgrading from an older build still carries it in its saved
// state, so HYDRATE reads it once to seed any league that predates the
// per-league column. Safe to delete once no device can still be running a build
// that wrote it.
export interface LegacyPersistedSettings {
  trackMisses?: boolean;
}

// Device-local preferences. Never synced to Supabase — favorites are personal
// to this phone (syncing them would share one person's stars with everyone).
export interface LocalPrefs {
  favLeagueIds: string[];
  favTeamIds: string[];
  /**
   * Leagues opened recently, newest first and BOUNDED - an unbounded list
   * rebuilds the unbounded pull it exists to avoid.
   */
  recentLeagueIds?: string[];
  /**
   * Leagues this account was last known to run (owner/scorekeeper).
   *
   * Cached because the authoritative answer needs a round trip and the FIRST
   * pull cannot wait for one: without a cache the opening pull would either
   * fetch nothing (and a scorekeeper's own league would arrive late) or fetch
   * everything (the problem). Refreshed after every successful membership read;
   * only ever a hint, never an authorisation decision - the server enforces
   * that.
   */
  memberLeagueIds?: string[];
  hapticsEnabled?: boolean; // live-tracker tap feedback (default on)
  seenOnboarding?: boolean; // dismissed the first-run explainer
  notifsEnabled?: boolean; // game reminders + final scores for favorites
}

export interface AppState {
  leagues: League[];
}

// Sponsor promo (Super-Admin managed). Global, not league-scoped.
export interface Promo {
  id: string;
  sponsorName?: string;
  title: string;
  tagline?: string;
  image?: string;   // compressed data URI
  link?: string;    // optional tap-through URL
  active: boolean;
  showOnHome?: boolean; // opt-in: also show the large spotlight card on Home (default off)
  taps: number;
  createdAt: number;
}

// A computed per-player box score line.
export interface StatLine {
  playerId: string | null;
  pts: number;
  fgm: number; fga: number;
  tpm: number; tpa: number;
  ftm: number; fta: number;
  oreb: number; dreb: number; reb: number;
  ast: number; stl: number; blk: number; tov: number; pf: number;
}
