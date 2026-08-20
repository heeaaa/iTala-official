/**
 * Rows to domain state.
 *
 * The exact inverse of the serialisers in ops.ts. Local storage and the server
 * hold the same flat, snake_case rows; the app operates on a tree with children
 * nested under their league. This module is the only place that gap is
 * bridged, and it is pure so the round trip can be property-tested.
 *
 * v1 spread the equivalent mapping through its sync layer with unchecked casts
 * (`type: r.type as GameEvent['type']`) and quiet coercions (`teamOnly:
 * r.team_only || undefined`, which turned false into undefined). External data
 * is validated here instead, at the boundary, and anything unrecognised is
 * dropped rather than smuggled into a typed object.
 */
import { DEFAULT_FOUL_OUT, DEFAULT_REGULATION_PERIODS } from './constants.js';
import type {
  AppState,
  Game,
  GameEvent,
  GameStatus,
  League,
  LeagueKind,
  Player,
  Team,
} from './types.js';
import { isEventType } from './types.js';

export type Row = Record<string, unknown>;

export interface RowSet {
  leagues: Row[];
  teams: Row[];
  players: Row[];
  games: Row[];
  events: Row[];
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : null;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export function leagueFromRow(r: Row): League | null {
  const id = str(r['id']);
  const name = str(r['name']);
  const season = str(r['season']);
  if (!id || name === null || season === null) return null;

  const kind = str(r['kind']);
  const reg = num(r['regulation_periods']);

  return {
    id,
    name,
    season,
    kind: (kind === 'recreational' ? 'recreational' : 'league') as LeagueKind,
    foulOutLimit: num(r['foul_out_limit']) ?? DEFAULT_FOUL_OUT,
    regulationPeriods: reg === 2 ? 2 : DEFAULT_REGULATION_PERIODS,
    trackMisses: bool(r['track_misses'], true),
    trackTurnovers: bool(r['track_turnovers'], false),
    createdAt: num(r['created_at']) ?? 0,
    teams: [],
    players: [],
    games: [],
    events: [],
  };
}

export function teamFromRow(r: Row): Team | null {
  const id = str(r['id']);
  const leagueId = str(r['league_id']);
  const name = str(r['name']);
  if (!id || !leagueId || name === null) return null;
  return {
    id,
    leagueId,
    name,
    color: str(r['color']) ?? '#3A78FF',
    logoUrl: str(r['logo_url']),
    playerIds: strArray(r['player_ids']),
    archivedAt: num(r['archived_at']),
    deletedAt: num(r['deleted_at']),
  };
}

export function playerFromRow(r: Row): Player | null {
  const id = str(r['id']);
  const leagueId = str(r['league_id']);
  const name = str(r['name']);
  if (!id || !leagueId || name === null) return null;
  return {
    id,
    leagueId,
    name,
    number: str(r['number']),
    personId: str(r['person_id']),
    deletedAt: num(r['deleted_at']),
  };
}

export function gameFromRow(r: Row): Game | null {
  const id = str(r['id']);
  const leagueId = str(r['league_id']);
  const home = str(r['home_team_id']);
  const away = str(r['away_team_id']);
  const status = str(r['status']);
  if (!id || !leagueId || !home || !away) return null;
  if (status !== 'live' && status !== 'final') return null;
  return {
    id,
    leagueId,
    homeTeamId: home,
    awayTeamId: away,
    status: status as GameStatus,
    scheduledAt: num(r['scheduled_at']),
    location: str(r['location']),
    finishedAt: num(r['finished_at']),
    homeOnCourt: strArray(r['home_on_court']),
    awayOnCourt: strArray(r['away_on_court']),
    period: num(r['period']) ?? 1,
  };
}

export function eventFromRow(r: Row): GameEvent | null {
  const id = str(r['id']);
  const leagueId = str(r['league_id']);
  const gameId = str(r['game_id']);
  const teamId = str(r['team_id']);
  const type = r['type'];
  const period = num(r['period']);
  const ts = num(r['ts']);
  if (!id || !leagueId || !gameId || !teamId || period === null || ts === null) return null;
  // An unrecognised type is dropped, not cast. The database has a check
  // constraint, so this only fires for rows written by a future version.
  if (!isEventType(type)) return null;
  return {
    id,
    leagueId,
    gameId,
    teamId,
    playerId: str(r['player_id']),
    type,
    period,
    ts,
    note: str(r['note']),
  };
}

/**
 * Rebuilds the whole tree. Children whose league is missing are dropped rather
 * than orphaned, which cannot happen through the app but can happen mid-pull.
 */
export function project(rows: RowSet): AppState {
  const leagues: League[] = [];
  const byId = new Map<string, League>();

  for (const r of rows.leagues) {
    const l = leagueFromRow(r);
    if (!l) continue;
    leagues.push(l);
    byId.set(l.id, l);
  }

  for (const r of rows.teams) {
    const t = teamFromRow(r);
    if (t) byId.get(t.leagueId)?.teams.push(t);
  }
  for (const r of rows.players) {
    const p = playerFromRow(r);
    if (p) byId.get(p.leagueId)?.players.push(p);
  }
  for (const r of rows.games) {
    const g = gameFromRow(r);
    if (g) byId.get(g.leagueId)?.games.push(g);
  }
  for (const r of rows.events) {
    const e = eventFromRow(r);
    if (e) byId.get(e.leagueId)?.events.push(e);
  }

  // Ordering is meaningful and must match what the reducer produces:
  // leagues and games newest first, everything else in insertion order.
  leagues.sort((a, b) => b.createdAt - a.createdAt);
  for (const l of leagues) {
    l.games.sort((a, b) => (b.scheduledAt ?? 0) - (a.scheduledAt ?? 0));
    l.events.sort((a, b) => (a.ts === b.ts ? a.id.localeCompare(b.id) : a.ts - b.ts));
  }

  return { leagues };
}
