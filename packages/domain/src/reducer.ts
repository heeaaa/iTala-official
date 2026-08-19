/**
 * The single mutation funnel.
 *
 * Every domain state change in the app goes through `reduce`. It is PURE:
 * no Date.now(), no Math.random(), no I/O. Every value that would otherwise be
 * ambient is carried on the action, which is what makes the golden tests
 * deterministic and what lets the sync layer be handed exact rows.
 *
 * v1 called Date.now() inside the reducer and generated IDs there too. Callers
 * now supply both. See docs/SPEC_DEVIATIONS.md D-8.
 */
import { MAX_PERIOD, TEAM_COLORS } from './constants.js';
import { foulLimit } from './stats.js';
import type { Op } from './ops.js';
import { eventRow, gameRow, leagueRow, playerRow, teamRow } from './ops.js';
import type {
  AppState,
  EventType,
  Game,
  GameEvent,
  League,
  LeagueKind,
  Player,
  Side,
  Team,
} from './types.js';

export type Action =
  /** Replaces the whole tree. Never produces sync operations. */
  | { t: 'HYDRATE'; state: AppState }
  | {
      t: 'ADD_LEAGUE';
      id: string;
      now: number;
      name: string;
      season: string;
      kind?: LeagueKind;
      foulOutLimit?: number;
      regulationPeriods?: 2 | 4;
      trackMisses?: boolean;
      trackTurnovers?: boolean;
    }
  | { t: 'ADD_TEAM'; id: string; leagueId: string; name: string; color?: string }
  | {
      t: 'ADD_PLAYER';
      id: string;
      leagueId: string;
      teamId: string;
      name: string;
      number?: string | null;
    }
  | {
      t: 'CREATE_GAME';
      id: string;
      now: number;
      leagueId: string;
      homeTeamId: string;
      awayTeamId: string;
      location?: string | null;
    }
  | { t: 'SET_LINEUP'; leagueId: string; gameId: string; side: Side; playerIds: string[] }
  | {
      t: 'ADD_EVENT';
      id: string;
      now: number;
      leagueId: string;
      gameId: string;
      teamId: string;
      playerId: string | null;
      type: EventType;
      period: number;
      note?: string | null;
    }
  | { t: 'UNDO_EVENT'; leagueId: string; gameId: string };

export interface ReduceResult {
  state: AppState;
  ops: Op[];
}

export const initialState = (): AppState => ({ leagues: [] });

const mapLeague = (state: AppState, leagueId: string, fn: (l: League) => League): AppState => ({
  ...state,
  leagues: state.leagues.map((l) => (l.id === leagueId ? fn(l) : l)),
});

const clampPeriod = (p: number): number => Math.min(MAX_PERIOD, Math.max(1, Math.floor(p)));

export function reduce(state: AppState, action: Action): ReduceResult {
  switch (action.t) {
    case 'HYDRATE':
      return { state: action.state, ops: [] };

    case 'ADD_LEAGUE': {
      const league: League = {
        id: action.id,
        name: action.name.trim() || 'New League',
        season: action.season.trim() || 'Season 1',
        kind: action.kind ?? 'league',
        foulOutLimit: action.foulOutLimit ?? 5,
        regulationPeriods: action.regulationPeriods ?? 4,
        trackMisses: action.trackMisses ?? true,
        trackTurnovers: action.trackTurnovers ?? false,
        createdAt: action.now,
        teams: [],
        players: [],
        games: [],
        events: [],
      };
      // Prepended, so the newest league appears first on the home screen.
      return {
        state: { ...state, leagues: [league, ...state.leagues] },
        ops: [{ op: 'upsert', table: 'leagues', row: leagueRow(league) }],
      };
    }

    case 'ADD_TEAM': {
      const target = state.leagues.find((l) => l.id === action.leagueId);
      if (!target) return { state, ops: [] };
      const team: Team = {
        id: action.id,
        leagueId: action.leagueId,
        name: action.name.trim() || `Team ${target.teams.length + 1}`,
        color: action.color ?? (TEAM_COLORS[target.teams.length % TEAM_COLORS.length] as string),
        logoUrl: null,
        playerIds: [],
        archivedAt: null,
        deletedAt: null,
      };
      return {
        state: mapLeague(state, action.leagueId, (l) => ({ ...l, teams: [...l.teams, team] })),
        ops: [{ op: 'upsert', table: 'teams', row: teamRow(team) }],
      };
    }

    case 'ADD_PLAYER': {
      const target = state.leagues.find((l) => l.id === action.leagueId);
      const team = target?.teams.find((t) => t.id === action.teamId);
      if (!target || !team) return { state, ops: [] };

      const player: Player = {
        id: action.id,
        leagueId: action.leagueId,
        name: action.name.trim() || 'Player',
        number: action.number?.trim() ? action.number.trim() : null,
        personId: null,
        deletedAt: null,
      };
      const nextTeam: Team = { ...team, playerIds: [...team.playerIds, player.id] };

      return {
        state: mapLeague(state, action.leagueId, (l) => ({
          ...l,
          players: [...l.players, player],
          teams: l.teams.map((t) => (t.id === nextTeam.id ? nextTeam : t)),
        })),
        // Two rows change: the player, and the team whose roster grew.
        ops: [
          { op: 'upsert', table: 'players', row: playerRow(player) },
          { op: 'upsert', table: 'teams', row: teamRow(nextTeam) },
        ],
      };
    }

    case 'CREATE_GAME': {
      const target = state.leagues.find((l) => l.id === action.leagueId);
      if (!target) return { state, ops: [] };
      const game: Game = {
        id: action.id,
        leagueId: action.leagueId,
        homeTeamId: action.homeTeamId,
        awayTeamId: action.awayTeamId,
        // Games are created already live. There is no scheduling path.
        status: 'live',
        scheduledAt: action.now,
        location: action.location ?? null,
        finishedAt: null,
        homeOnCourt: [],
        awayOnCourt: [],
        period: 1,
      };
      return {
        state: mapLeague(state, action.leagueId, (l) => ({ ...l, games: [game, ...l.games] })),
        ops: [{ op: 'upsert', table: 'games', row: gameRow(game) }],
      };
    }

    case 'SET_LINEUP': {
      const target = state.leagues.find((l) => l.id === action.leagueId);
      const game = target?.games.find((g) => g.id === action.gameId);
      if (!target || !game) return { state, ops: [] };
      const key = action.side === 'home' ? 'homeOnCourt' : 'awayOnCourt';
      const next: Game = { ...game, [key]: action.playerIds.slice(0, 5) };
      return {
        state: mapLeague(state, action.leagueId, (l) => ({
          ...l,
          games: l.games.map((g) => (g.id === next.id ? next : g)),
        })),
        ops: [{ op: 'upsert', table: 'games', row: gameRow(next) }],
      };
    }

    case 'ADD_EVENT': {
      const target = state.leagues.find((l) => l.id === action.leagueId);
      const game = target?.games.find((g) => g.id === action.gameId);
      if (!target || !game) return { state, ops: [] };

      const event: GameEvent = {
        id: action.id,
        leagueId: action.leagueId,
        gameId: action.gameId,
        teamId: action.teamId,
        playerId: action.playerId,
        type: action.type,
        period: clampPeriod(action.period),
        ts: action.now,
        note: action.note ?? null,
      };

      const events = [...target.events, event];
      const ops: Op[] = [{ op: 'insert', table: 'events', row: eventRow(event) }];

      // Automatic foul-out. Recomputed from the new event list rather than
      // trusted from the caller, so the bench always agrees with the box score.
      let games = target.games;
      if (event.type === 'pf' && event.playerId) {
        const limit = foulLimit(target);
        let fouls = 0;
        for (const e of events) {
          if (e.gameId === event.gameId && e.playerId === event.playerId && e.type === 'pf') {
            fouls++;
          }
        }
        if (fouls >= limit) {
          const pid = event.playerId;
          const nextGame: Game = {
            ...game,
            homeOnCourt: game.homeOnCourt.filter((x) => x !== pid),
            awayOnCourt: game.awayOnCourt.filter((x) => x !== pid),
          };
          games = target.games.map((g) => (g.id === nextGame.id ? nextGame : g));
          ops.push({ op: 'upsert', table: 'games', row: gameRow(nextGame) });
        }
      }

      return {
        state: mapLeague(state, action.leagueId, (l) => ({ ...l, events, games })),
        ops,
      };
    }

    case 'UNDO_EVENT': {
      const target = state.leagues.find((l) => l.id === action.leagueId);
      if (!target) return { state, ops: [] };
      const forGame = target.events.filter((e) => e.gameId === action.gameId);
      const last = forGame[forGame.length - 1];
      if (!last) return { state, ops: [] };

      // v1's most significant defect was that undo produced NO sync operation,
      // so the event stayed on the server and the next refetch resurrected it.
      // The reducer has always known the id. Now it hands it over.
      return {
        state: mapLeague(state, action.leagueId, (l) => ({
          ...l,
          events: l.events.filter((e) => e.id !== last.id),
        })),
        ops: [{ op: 'delete', table: 'events', id: last.id }],
      };
    }
  }
}
