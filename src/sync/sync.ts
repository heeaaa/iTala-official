// Sync layer between the local reducer state and Supabase.
//
// Strategy: the local reducer remains the source of truth for UI state and is
// always written to AsyncStorage (offline-first). When sync is enabled we ALSO
// mirror mutations to Supabase tables and subscribe to changes from other
// devices via Realtime. If a network call fails, the local state stays correct
// and the next successful operation reconverges things.
//
// Conflict policy: LAST WRITE WINS. Two scorekeepers should not be on the same
// game; if they are, the most recent write replaces the earlier one. Events
// are append-only with unique client-generated ids, so concurrent stat logs
// from different games never collide.

import { SupabaseClient } from '@supabase/supabase-js';
import { Action } from '../store/StoreProvider';
import { AppState, GameEvent, League, Player, Team, Game } from '../types';
import { warn } from '../lib/log';

/* ---------- Row shapes (snake_case columns ↔ camelCase types) -------------- */

interface LeagueRow { id: string; name: string; season: string; kind: 'league' | 'recreational'; foul_out_limit: number | null; track_misses: boolean | null; track_turnovers: boolean | null; is_shared: boolean | null; is_closed: boolean | null; is_archived: boolean | null; created_at: number; }
interface TeamRow   { id: string; league_id: string; name: string; color: string; logo: string | null; coach: string | null; team_only: boolean; player_ids: string[]; }
interface PlayerRow { id: string; league_id: string; name: string; number: string | null; origin_player_id: string | null; }
interface GameRow   { id: string; league_id: string; home_team_id: string; away_team_id: string; status: 'scheduled'|'live'|'final'; scheduled_at: number | null; location: string | null; finished_at: number | null; home_on_court: string[]; away_on_court: string[]; period: number | null; attendance: string[] | null; track_misses: boolean | null; track_turnovers: boolean | null; created_by: string | null; }
interface EventRow  { id: string; league_id: string; game_id: string; team_id: string; player_id: string | null; type: string; period: number; ts: number; note: string | null; }

const leagueFromRow = (r: LeagueRow, teams: Team[], players: Player[], games: Game[], events: GameEvent[]): League => ({
  id: r.id, name: r.name, season: r.season, kind: r.kind,
  foulOutLimit: r.foul_out_limit ?? undefined,
  // null = row predates the per-league setting; leave undefined so the
  // HYDRATE migration seeds it from the legacy global.
  trackMisses: r.track_misses ?? undefined,
  trackTurnovers: r.track_turnovers ?? undefined,
  isShared: r.is_shared || undefined,
  isClosed: r.is_closed || undefined,
  isArchived: r.is_archived || undefined,
  createdAt: r.created_at, teams, players, games, events,
});
const teamFromRow = (r: TeamRow): Team => ({
  id: r.id, name: r.name, color: r.color, playerIds: r.player_ids,
  logo: r.logo ?? undefined, teamOnly: r.team_only || undefined,
  coach: r.coach ?? undefined,
});
const playerFromRow = (r: PlayerRow): Player => ({
  id: r.id, name: r.name, number: r.number ?? undefined,
  originPlayerId: r.origin_player_id ?? undefined,
});
const gameFromRow = (r: GameRow): Game => ({
  id: r.id, leagueId: r.league_id, homeTeamId: r.home_team_id, awayTeamId: r.away_team_id,
  attendance: r.attendance ?? undefined,
  trackMisses: r.track_misses ?? undefined,
  trackTurnovers: r.track_turnovers ?? undefined,
  status: r.status,
  scheduledAt: r.scheduled_at ?? undefined,
  location: r.location ?? undefined,
  finishedAt: r.finished_at ?? undefined,
  createdBy: r.created_by ?? undefined,
  homeOnCourt: r.home_on_court ?? [],
  awayOnCourt: r.away_on_court ?? [],
  period: r.period ?? undefined,
});
const eventFromRow = (r: EventRow): GameEvent => ({
  id: r.id, gameId: r.game_id, teamId: r.team_id,
  playerId: r.player_id, type: r.type as GameEvent['type'],
  period: r.period, ts: r.ts, note: r.note ?? undefined,
});

/* ---------- Initial pull: fetch all data, return as AppState ---------------- */

export async function fetchAllState(sb: SupabaseClient): Promise<Partial<AppState> | null> {
  // Every query is explicitly ordered. Without .order(), PostgREST returns
  // rows in arbitrary order (often whichever row was updated last moves) —
  // which made lists visibly shuffle after each realtime re-pull, and could
  // even change which event "Undo" considered the latest.
  const [lr, tr, pr, gr, er] = await Promise.all([
    sb.from('leagues').select('*').order('created_at', { ascending: false }), // newest first, matches local prepend
    sb.from('teams').select('*').order('name'),                               // alphabetical, matches render order
    sb.from('players').select('*').order('name'),
    sb.from('games').select('*').order('scheduled_at', { ascending: false }),
    // Chronological, with `id` breaking ties. `ts` alone is not a total order
    // — two taps in the same millisecond leave PostgREST free to return them
    // either way round, and "the last event of this game" IS the definition of
    // Undo. The client sorts by the same (ts, id) key (see compareEvents), so
    // both sides always name the same row.
    sb.from('events').select('*').order('ts').order('id'),
  ]);

  if (lr.error) { warn('[sync] fetch leagues error:', lr.error.message); return null; }
  if (tr.error || pr.error || gr.error || er.error) {
    warn('[sync] fetch error:', tr.error?.message ?? pr.error?.message ?? gr.error?.message ?? er.error?.message);
    return null;
  }

  const leagueRows = lr.data as LeagueRow[];

  const leagues = leagueRows.map(lRow => {
    const teams   = (tr.data as TeamRow[]).filter(x => x.league_id === lRow.id).map(teamFromRow);
    const players = (pr.data as PlayerRow[]).filter(x => x.league_id === lRow.id).map(playerFromRow);
    const games   = (gr.data as GameRow[]).filter(x => x.league_id === lRow.id).map(gameFromRow);
    const events  = (er.data as EventRow[]).filter(x => x.league_id === lRow.id).map(eventFromRow);
    return leagueFromRow(lRow, teams, players, games, events);
  });

  return { leagues };
}

/* ---------- Push: mirror an action's effect to Supabase --------------------- */
// We translate the *intent* of each action to a row-level operation. The post-
// reducer `state` is passed in so we can look up the new shape of things (e.g.
// after ADD_PLAYER we read the team's updated playerIds and upsert the team).

// Logs PostgREST/RLS-style errors from a Supabase response. Network failures
// throw and are caught below; row-level rejections come back in .error.
// `any` is deliberate: this only ever reads .error off an arbitrary PostgREST
// response shape, and narrowing it would mean restating every response type.
function check(label: string, res: { error: any }): void {
  if (res?.error) {
    warn(`[sync] ${label} rejected:`, res.error.message ?? res.error);
  }
}

// For writes where a silent failure means the user LOSES data they can see on
// screen (creating a drop-in game, importing a roster). These rethrow so the
// sync badge shows 'error' instead of falsely reporting 'saved' while the
// server has nothing — the failure mode that hid the drop-in game bugs.
function checkCritical(label: string, res: { error: any }): void {
  if (res?.error) {
    const msg = res.error.message ?? String(res.error);
    warn(`[sync] ${label} FAILED:`, msg);
    throw new Error(`${label}: ${msg}`);
  }
}

// Actions whose push MUST reject when it fails.
//
// Everything else can fail quietly and reconverge on the next pull. These
// cannot, because the person is looking at the result: a logged basket, an
// undone mis-tap, a drop-in game they just set up. Two things depend on the
// rejection reaching the caller — the sync badge turning red, and the pending
// ledger pinning the local value so a later snapshot does not quietly rewrite
// the score (see sync/pendingEvents.ts).
//
// This used to be a regex over the thrown message, which meant a write only
// counted as critical if its label happened to be spelled into the pattern.
// INSERT_events was not, so with the network down every logged stat reported
// 'saved', the ledger was told the server had it, and the next pull deleted it.
const MUST_NOT_FAIL_SILENTLY: ReadonlySet<Action['t']> = new Set([
  'ADD_EVENT', 'REDO_EVENT', 'UNDO_EVENT', 'DELETE_EVENT',
  'REC_SETUP_GAME', 'BULK_IMPORT_ROSTER',
]);

/**
 * A push that writes NOTHING must never resolve. This is the message for the
 * case where the row an action is supposed to mirror is not in the state handed
 * to us.
 *
 * These sites used to `return` quietly, and quietly is the one thing they could
 * not afford. The caller treats a resolved push as "the server has it" and the
 * pending ledger used to retire the entry on that basis, so the very next
 * snapshot deleted the row locally - about a second after the tap, with no
 * error, no badge and nothing in the play-by-play. Every symptom of a stat that
 * will not stick, and no evidence anywhere.
 *
 * `reconcileLeagueEvents` now checks the snapshot's contents before retiring, so
 * this can no longer lose the stat on its own. It is still wrong to report
 * success for a write that never happened: pinned-and-silent is a slow leak, and
 * the person deserves to know now rather than at the buzzer.
 *
 * It is also never a legitimate state - the reducer created that row immediately
 * before this ran. The realistic way to reach it is a queued push whose rows were
 * removed underneath it (a rolled-back drop-in bundle, a deleted game), and there
 * the stat genuinely cannot be saved, so an error is the truth.
 */
function missingRow(label: string, id: string | undefined, leagueId: string): never {
  throw new Error(
    `${label}: nothing to push - no local row for ${id ?? '(no id)'} in league ${leagueId}. `
    + 'The write was not attempted, so this reports a failure rather than a false save.',
  );
}

export async function pushAction(sb: SupabaseClient, action: Action, state: AppState): Promise<void> {
  try {
    switch (action.t) {
      case 'DUPLICATE_LEAGUE': {
        const l = state.leagues.find(x => x.id === action.newLeagueId);
        if (!l) return;
        // Server: owners of the source league duplicate without a creation code.
        check('DUPLICATE_LEAGUE', await sb.rpc('create_league', {
          p_id: l.id, p_name: l.name, p_season: l.season,
          p_kind: l.kind ?? 'league',
          p_foul_out: l.foulOutLimit ?? null,
          p_track_misses: l.trackMisses ?? true,
          p_track_turnovers: l.trackTurnovers ?? true,
          p_created_at: l.createdAt,
          p_code: null, p_shared: false,
          p_source_league: action.sourceLeagueId,
        }));
        if (l.teams.length) {
          check('DUPLICATE_teams', await sb.from('teams').upsert(l.teams.map(t => ({
            id: t.id, league_id: l.id, name: t.name, color: t.color,
            logo: t.logo ?? null, coach: t.coach ?? null, team_only: !!t.teamOnly, player_ids: t.playerIds,
          }))));
        }
        if (l.players.length) {
          check('DUPLICATE_players', await sb.from('players').upsert(l.players.map(pl => ({
            id: pl.id, league_id: l.id, name: pl.name, number: pl.number ?? null,
            origin_player_id: pl.originPlayerId ?? null,
          }))));
        }
        break;
      }

      case 'ADD_LEAGUE': {
        const l = state.leagues.find(x => x.id === action.id);
        if (!l) return;
        // League creation is an RPC, not a table insert: the server validates
        // (and consumes) the single-use creation code, inserts the row, and
        // records the caller as the league's owner — all atomically.
        check('ADD_LEAGUE', await sb.rpc('create_league', {
          p_id: l.id, p_name: l.name, p_season: l.season,
          p_kind: l.kind ?? 'league',
          p_foul_out: l.foulOutLimit ?? null,
          p_track_misses: l.trackMisses ?? true,
          p_track_turnovers: l.trackTurnovers ?? true,
          p_created_at: l.createdAt,
          p_code: action.creationCode ?? null,
          p_shared: l.isShared ?? false,
        }));
        break;
      }
      case 'DELETE_LEAGUE':
        check('DELETE_LEAGUE', await sb.from('leagues').delete().eq('id', action.leagueId));
        break;

      case 'ADD_TEAM': {
        const l = state.leagues.find(x => x.id === action.leagueId);
        const t = action.id ? l?.teams.find(x => x.id === action.id) : l?.teams[l.teams.length - 1];
        if (!l || !t) return;
        check('UPSERT_teams', await sb.from('teams').upsert({
          id: t.id, league_id: l.id, name: t.name, color: t.color,
          logo: t.logo ?? null, coach: t.coach ?? null, team_only: !!t.teamOnly, player_ids: t.playerIds,
        }));
        break;
      }
      case 'UPDATE_TEAM': {
        const l = state.leagues.find(x => x.id === action.leagueId);
        const t = l?.teams.find(x => x.id === action.teamId);
        if (!l || !t) return;
        check('UPSERT_teams', await sb.from('teams').upsert({
          id: t.id, league_id: l.id, name: t.name, color: t.color,
          logo: t.logo ?? null, coach: t.coach ?? null, team_only: !!t.teamOnly, player_ids: t.playerIds,
        }));
        break;
      }
      case 'DELETE_TEAM':
        check('DELETE_teams', await sb.from('teams').delete().eq('id', action.teamId));
        break;

      case 'ADD_PLAYER': {
        const l = state.leagues.find(x => x.id === action.leagueId);
        const p = action.id ? l?.players.find(x => x.id === action.id) : l?.players[l.players.length - 1];
        if (!l || !p) return;
        // ONE transaction server-side (player insert + team player_ids update).
        // Two separate writes let a realtime re-pull land in between, briefly
        // hydrating a player no team claimed — the "vanishing new player" bug.
        check('ADD_PLAYER', await sb.rpc('add_player', {
          p_league_id: l.id, p_team_id: action.teamId,
          p_player_id: p.id, p_name: p.name, p_number: p.number ?? null,
        }));
        break;
      }
      case 'UPDATE_PLAYER': {
        const l = state.leagues.find(x => x.id === action.leagueId);
        const p = l?.players.find(x => x.id === action.playerId);
        if (!l || !p) return;
        check('UPSERT_players', await sb.from('players').upsert({
          id: p.id, league_id: l.id, name: p.name, number: p.number ?? null,
        }));
        break;
      }
      case 'DELETE_PLAYER': {
        // The reducer also removes the player from their team's playerIds — push that team update.
        const l = state.leagues.find(x => x.id === action.leagueId);
        check('DELETE_players', await sb.from('players').delete().eq('id', action.playerId));
        if (l) {
          for (const t of l.teams) {
            check('UPSERT_teams', await sb.from('teams').upsert({
              id: t.id, league_id: l.id, name: t.name, color: t.color,
              logo: t.logo ?? null, team_only: !!t.teamOnly, player_ids: t.playerIds,
            }));
          }
        }
        break;
      }

      case 'CREATE_GAME': {
        const l = state.leagues.find(x => x.id === action.leagueId);
        const g = l?.games.find(x => x.id === action.id);
        if (!l || !g) return;
        check('UPSERT_games', await sb.from('games').upsert(gameToRow(g)));
        break;
      }
      case 'DELETE_GAME':
        // events cascade-delete in the schema (game_id FK on delete cascade)
        check('DELETE_games', await sb.from('games').delete().eq('id', action.gameId));
        break;

      case 'BULK_IMPORT_ROSTER': {
        // One round trip, one server-side transaction — see bulk_import_roster
        // in schema.sql for why this must be atomic rather than one action per
        // team/player (that ordering-free burst is what caused the FK race).
        const l = state.leagues.find(x => x.id === action.leagueId);
        if (!l) break;
        const justAdded = new Set(action.teams.map(t => t.id));
        const payload = l.teams.filter(t => justAdded.has(t.id)).map(t => ({
          id: t.id, name: t.name, color: t.color,
          players: t.playerIds.map(pid => {
            const p = l.players.find(x => x.id === pid);
            return { id: pid, name: p?.name ?? '', number: p?.number ?? '' };
          }),
        }));
        checkCritical('BULK_IMPORT_ROSTER', await sb.rpc('bulk_import_roster', { p_league_id: l.id, p_teams: payload }));
        break;
      }

      case 'CLEANUP_REC_GAMES': {
        // Delete the games first (events cascade via FK). Then remove teams and
        // players that the reducer pruned (i.e. no longer present locally),
        // which are exactly the ones used only by the deleted games.
        for (const gid of action.gameIds) {
          check('CLEANUP_games', await sb.from('games').delete().eq('id', gid));
        }
        const l = state.leagues.find(x => x.id === action.leagueId);
        if (l) {
          const liveTeamIds = new Set(l.teams.map(t => t.id));
          const livePlayerIds = new Set(l.players.map(p => p.id));
          // Pull server rows for this league and delete any not still local.
          const [{ data: tRows }, { data: pRows }] = await Promise.all([
            sb.from('teams').select('id').eq('league_id', l.id),
            sb.from('players').select('id').eq('league_id', l.id),
          ]);
          for (const r of (tRows ?? []) as { id: string }[]) {
            if (!liveTeamIds.has(r.id)) check('CLEANUP_teams', await sb.from('teams').delete().eq('id', r.id));
          }
          for (const r of (pRows ?? []) as { id: string }[]) {
            if (!livePlayerIds.has(r.id)) check('CLEANUP_players', await sb.from('players').delete().eq('id', r.id));
          }
        }
        break;
      }

      case 'SET_LINEUP':
      case 'SET_LINEUPS':
      case 'SUBSTITUTE':
      case 'SET_ATTENDANCE':
      case 'SET_GAME_STATUS':
      case 'SET_PERIOD': {
        const l = state.leagues.find(x => x.id === action.leagueId);
        const g = l?.games.find(x => x.id === action.gameId);
        if (g) check('UPSERT_games', await sb.from('games').upsert(gameToRow(g)));
        break;
      }

      case 'ADD_EVENT': {
        const l = state.leagues.find(x => x.id === action.leagueId);
        // By id, not by position. Events are held in canonical (ts, id) order to
        // match the server's, so the row this action created is not necessarily
        // the last element — stampActionIds put its id on the action for exactly
        // this lookup.
        const ev = action.id ? l?.events.find(e => e.id === action.id) : undefined;
        if (!l || !ev) missingRow('ADD_EVENT', action.id, action.leagueId);
        checkCritical('INSERT_events', await sb.from('events').insert({
          id: ev.id, league_id: l.id, game_id: ev.gameId, team_id: ev.teamId,
          player_id: ev.playerId, type: ev.type, period: ev.period, ts: ev.ts, note: ev.note ?? null,
        }));
        // Foul-out auto-bench: the reducer also removes the fouled-out player from court — push the game.
        const g = l.games.find(x => x.id === action.gameId);
        if (action.type === 'pf' && g) check('UPSERT_games', await sb.from('games').upsert(gameToRow(g)));
        break;
      }
      case 'UNDO_EVENT': {
        // The dispatch wrapper resolves which event was undone (the id only
        // exists in the PRE-dispatch state) and passes it here. Deleting it
        // server-side is essential: without it the row survives on the server
        // and the undone stat reappears on the next pull, silently reverting
        // the scoreboard.
        if (!action.eventId) {
          warn('[sync] UNDO_EVENT arrived without an eventId — nothing deleted server-side');
          break;
        }
        // .select() so we get the deleted rows back. PostgREST does NOT report an
        // error when row-level security hides the rows a DELETE targeted — it
        // succeeds having removed nothing. Without asking for the rows, a
        // scorekeeper whose rights lapsed mid-game (league closed, membership
        // revoked) gets a clean-looking undo and the stat back on the next pull.
        const res = await sb.from('events').delete().eq('id', action.eventId).select('id');
        if (res.error) {
          // A failed undo delete guarantees the stat comes back, so this is one
          // of the writes worth surfacing rather than logging. checkCritical
          // rethrows and the caller flips the sync badge to 'error'.
          checkCritical('UNDO_EVENT', res);
        } else if ((res.data ?? []).length === 0) {
          // Nothing was removed. Two very different causes, so read the row back
          // to tell them apart:
          //   - it never reached the server (logged while offline) → fine
          //   - it is still there → the delete was refused, and the next pull
          //     will undo the undo
          const back = await sb.from('events').select('id').eq('id', action.eventId);
          if (!back.error && (back.data ?? []).length > 0) {
            throw new Error(`UNDO_EVENT: server refused to delete event ${action.eventId}`);
          }
        }
        // Undo also reverses the foul-out auto-bench (see the reducer), so the
        // game row has to go back up or the restored player is only on court on
        // this device.
        const lg = state.leagues.find(x => x.id === action.leagueId);
        const gm = lg?.games.find(x => x.id === action.gameId);
        if (gm) check('UPSERT_games(undo)', await sb.from('games').upsert(gameToRow(gm)));
        break;
      }

      case 'REDO_EVENT': {
        // Redo re-adds the event locally; mirror it back to the server or it
        // would vanish again on the next pull. By id (see ADD_EVENT): a redone
        // event goes back to its own place in ts order, not to the end.
        const l = state.leagues.find(x => x.id === action.leagueId);
        const ev = action.eventId ? l?.events.find(e => e.id === action.eventId) : undefined;
        if (!l || !ev) missingRow('REDO_EVENT', action.eventId, action.leagueId);
        checkCritical('INSERT_events(redo)', await sb.from('events').upsert({
          id: ev.id, league_id: l.id, game_id: ev.gameId, team_id: ev.teamId,
          player_id: ev.playerId, type: ev.type, period: ev.period, ts: ev.ts, note: ev.note ?? null,
        }));
        break;
      }

      case 'DELETE_EVENT': {
        checkCritical('DELETE_events', await sb.from('events').delete().eq('id', action.eventId));
        // Deleting a foul-out-causing foul restores the player to court (see
        // the reducer) — push the game row so other devices pick it up too.
        const l = state.leagues.find(x => x.id === action.leagueId);
        const g = l?.games.find(x => x.id === action.gameId);
        if (g) check('UPSERT_games(delete_event)', await sb.from('games').upsert(gameToRow(g)));
        break;
      }

      case 'SET_LEAGUE_SETTINGS': {
        const patch: Record<string, boolean> = {};
        if (action.trackMisses !== undefined) patch.track_misses = action.trackMisses;
        if (action.trackTurnovers !== undefined) patch.track_turnovers = action.trackTurnovers;
        if (action.isClosed !== undefined) patch.is_closed = action.isClosed;
        if (action.isArchived !== undefined) patch.is_archived = action.isArchived;
        if (Object.keys(patch).length === 0) break;
        check('SET_LEAGUE_SETTINGS', await sb.from('leagues').update(patch).eq('id', action.leagueId));
        break;
      }

      case 'REC_SETUP_GAME': {
        const l = state.leagues.find(x => x.id === action.leagueId);
        if (!l) missingRow('REC_SETUP_GAME', action.gameId, action.leagueId);
        // ONE atomic call — league + teams + players + game in a single
        // transaction. This replaced four sequential round trips, which left
        // windows where the server held a partial bundle; a realtime echo
        // landing in one of those windows made the client pull the partial
        // state and drop the game/teams locally.
        const g = l.games.find(x => x.id === action.gameId);
        const payload = action.teams.map(td => {
          const t = l.teams.find(x => x.id === td.id);
          return {
            id: td.id,
            name: t?.name ?? td.name,
            color: t?.color ?? td.color ?? '#12D7D0',
            players: td.players.map(pd => ({ id: pd.id, name: pd.name, number: pd.number ?? '' })),
          };
        });
        checkCritical('REC_setup_game', await sb.rpc('rec_setup_game', {
          p_league_id: l.id,
          p_league_name: action.ensureLeague?.name ?? l.name,
          p_shared: action.ensureLeague?.isShared ?? l.isShared ?? false,
          p_created_at: g?.scheduledAt ?? l.createdAt,
          p_game_id: action.gameId,
          p_location: action.location ?? '',
          p_track_misses: action.trackMisses ?? null,
          p_track_turnovers: action.trackTurnovers ?? null,
          p_teams: payload,
        }));
        break;
      }

      case 'HYDRATE':
        // Local hydrate only — no server write.
        return;

      case 'ROLLBACK_BUNDLE':
        // Local only, and deliberately so. This action exists BECAUSE the server
        // write failed: rec_setup_game and bulk_import_roster are single
        // transactions, so nothing was written and there is nothing to delete.
        // Pushing anything here would risk removing rows a retry had since
        // succeeded in creating.
        return;
    }
  } catch (e: unknown) {
    // Network or auth errors should never crash the UI. They'll reconverge on
    // the next push or pull. Critical bundle writes (see checkCritical) are
    // rethrown so the caller can show a real error instead of a false 'saved'.
    const msg = (e as Error)?.message ?? String(e);
    warn('sync push failed:', msg);
    // Keyed off the action, not off how the message happens to be worded. A
    // network TypeError carries no label at all, so a message test could never
    // have classified the case that matters most.
    if (MUST_NOT_FAIL_SILENTLY.has(action.t)) throw e;
  }
}

function gameToRow(g: Game) {
  return {
    id: g.id, league_id: g.leagueId, home_team_id: g.homeTeamId, away_team_id: g.awayTeamId,
    status: g.status,
    scheduled_at: g.scheduledAt ?? null,
    location: g.location ?? null,
    finished_at: g.finishedAt ?? null,
    home_on_court: g.homeOnCourt ?? [],
    away_on_court: g.awayOnCourt ?? [],
    period: g.period ?? 1,
    attendance: g.attendance ?? null,
    track_misses: g.trackMisses ?? null,
    track_turnovers: g.trackTurnovers ?? null,
  };
}

/* ---------- Realtime subscription: pull changes from other devices --------- */

export interface PullHandlers {
  onLeagueChange: (id: string) => void;       // re-fetch full league when any league/team/player/game/event row changes
}

export function subscribeRealtime(sb: SupabaseClient, onAnyChange: () => void) {
  const channel = sb.channel('itala-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'leagues' },      onAnyChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' },        onAnyChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players' },      onAnyChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'games' },        onAnyChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'events' },       onAnyChange)
    .subscribe();
  return () => { sb.removeChannel(channel); };
}
