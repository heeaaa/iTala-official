/**
 * Sync operations.
 *
 * The reducer emits these alongside the new state. This is the fix for v1's
 * single most dangerous coupling: its sync layer located the row that had just
 * been created by taking `array[array.length - 1]`, an invisible contract
 * between two files. Changing an append to a prepend would have silently
 * pushed the wrong row, with no type error and no test to catch it.
 *
 * Here the reducer, which knows exactly what changed, says so explicitly. The
 * sync layer is dumb and does what it is told.
 */
import type { Game, GameEvent, League, Player, Team } from './types.js';

export type Table = 'leagues' | 'teams' | 'players' | 'games' | 'events';

export type Op =
  /** Idempotent by primary key. Safe to replay. */
  | { op: 'upsert'; table: Table; row: Record<string, unknown> }
  /**
   * Insert, NOT upsert. The primary key is what makes double-logging a stat
   * impossible: a replayed insert either succeeds or hits a PK conflict, and
   * both outcomes mean "this event is on the server exactly once". Do not
   * change this to an upsert without thinking very hard about it.
   */
  | { op: 'insert'; table: Table; row: Record<string, unknown> }
  | { op: 'delete'; table: Table; id: string };

export const leagueRow = (l: League): Record<string, unknown> => ({
  id: l.id,
  name: l.name,
  season: l.season,
  kind: l.kind,
  foul_out_limit: l.foulOutLimit,
  regulation_periods: l.regulationPeriods,
  track_misses: l.trackMisses,
  track_turnovers: l.trackTurnovers,
  created_at: l.createdAt,
});

export const teamRow = (t: Team): Record<string, unknown> => ({
  id: t.id,
  league_id: t.leagueId,
  name: t.name,
  color: t.color,
  logo_url: t.logoUrl ?? null,
  player_ids: t.playerIds,
  archived_at: t.archivedAt ?? null,
  deleted_at: t.deletedAt ?? null,
});

export const playerRow = (p: Player): Record<string, unknown> => ({
  id: p.id,
  league_id: p.leagueId,
  name: p.name,
  number: p.number ?? null,
  person_id: p.personId ?? null,
  deleted_at: p.deletedAt ?? null,
});

export const gameRow = (g: Game): Record<string, unknown> => ({
  id: g.id,
  league_id: g.leagueId,
  home_team_id: g.homeTeamId,
  away_team_id: g.awayTeamId,
  status: g.status,
  scheduled_at: g.scheduledAt ?? null,
  location: g.location ?? null,
  finished_at: g.finishedAt ?? null,
  home_on_court: g.homeOnCourt ?? [],
  away_on_court: g.awayOnCourt ?? [],
  period: g.period ?? 1,
});

export const eventRow = (e: GameEvent): Record<string, unknown> => ({
  id: e.id,
  league_id: e.leagueId,
  game_id: e.gameId,
  team_id: e.teamId,
  player_id: e.playerId,
  type: e.type,
  period: e.period,
  ts: e.ts,
  note: e.note ?? null,
});
