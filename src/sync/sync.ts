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
import { OutboxEntry } from './pendingEvents';
import { isNetworkFailure } from '../store/authErrors';

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

/** One PostgREST response, as much of it as anything here reads. */
interface ReadResult {
  data: any[] | null;
  error: any;
  status?: number;
}

/** Rows asked for per request. The server is free to answer with fewer. */
const PAGE_SIZE = 1000;

/**
 * A runaway backstop, NOT a row ceiling. Keyset paging finishes when the server
 * runs out of rows, so this is only reached if the cursor stops advancing. The
 * offset version used its equivalent as a de facto 200,000-row limit, past
 * which every pull failed for ever while the app still said "Connected".
 */
const MAX_PAGES = 5000;

/**
 * Read EVERY row of one query, a page at a time, walking `id` upwards.
 *
 * WHY KEYSET AND NOT OFFSET.
 *
 * PostgREST will not return more rows than `db-max-rows`, and it does not say
 * when it has capped a reply: the response is an ordinary success carrying a
 * short array. So the read has to be paged - that is N-39. The obvious way,
 * `.range(from, to)`, compiles to OFFSET/LIMIT, and OFFSET is defined against a
 * result set other people are changing while we walk it:
 *
 *   Page 1 reads rows 0-999. Someone, anywhere, taps Undo, which DELETEs an
 *   event row behind our cursor. Every later row shifts down one offset. Page 2
 *   asks for offset 1000 and is given what was row 1001 - the row that was at
 *   1000 is now at 999, already passed, and is never read. The exact count
 *   shrank by the same one, so `rows.length === count` and the read reports
 *   success.
 *
 * The snapshot then holds a row the server deleted AND omits one it still has.
 * Because a confirmed write is retired from the ledger seconds after the tap,
 * `reconcileLeagueEvents` has nothing to object with: HYDRATE drops the missing
 * event and the autosave persists the loss. That is N-39 again, reached by a
 * stranger's Undo instead of by row count - and no restart required.
 *
 * A cursor on `id` has no such window. All five tables are `id text primary
 * key` (supabase/schema.sql), immutable and unique, so "everything after this
 * id" names the same boundary however the table is edited around it. A
 * surviving row can never be stepped over, and completeness stops depending on
 * a count that moves while we read - so the exact count, which cost a full
 * COUNT(*) per request on every pull, is gone entirely.
 *
 * Only an EMPTY page proves the walk finished. A short page does not: a project
 * whose `db-max-rows` is below PAGE_SIZE answers every page short, and reading
 * that as the end would reintroduce the original truncation. Running out of
 * pages is therefore an ERROR, never a short snapshot - a short snapshot is
 * precisely the thing that deletes a scorekeeper's game.
 *
 * The trade is that a row INSERTED below the cursor mid-read is missed until the
 * next pull. That is the safe direction, and a different thing entirely: it
 * withholds a row that has just appeared rather than deleting one that exists.
 */
async function readAll(
  page: (afterId: string | null, limit: number) => PromiseLike<ReadResult>,
): Promise<ReadResult> {
  const rows: any[] = [];
  // A row that arrives twice is the same row twice, and would DOUBLE a score.
  // Strict `.gt(id, cursor)` should make that impossible; this is the guard for
  // a server that ignores the cursor, which the advance check below then fails.
  const seen = new Set<string>();
  let cursor: string | null = null;
  let last: ReadResult | null = null;
  let complete = false;

  for (let i = 0; i < MAX_PAGES; i++) {
    const res: ReadResult = await page(cursor, PAGE_SIZE);
    last = res;
    if (res.error) return res;
    const batch = res.data ?? [];
    // Nothing after the cursor: the walk is done, whatever the server was
    // capping each reply at.
    if (batch.length === 0) { complete = true; break; }

    let high: string | null = null;
    for (const row of batch) {
      const id = row?.id;
      // Paging is only as sound as its key. A row with no string id cannot be
      // positioned, and guessing is how a score changes - so the read fails.
      if (typeof id !== 'string') {
        return {
          data: null,
          error: { message: 'readAll: a row arrived with no string id; cannot page safely' },
          status: res.status,
        };
      }
      if (high === null || id > high) high = id;
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(row);
    }

    // The cursor MUST move. A server that ignores `.gt` and re-answers the same
    // page would otherwise be walked for ever, and stopping quietly here would
    // hand back a prefix.
    if (high === null || (cursor !== null && high <= cursor)) {
      return {
        data: null,
        error: { message: 'readAll: the page cursor did not advance; the read cannot be completed' },
        status: res.status,
      };
    }
    cursor = high;
  }

  if (last === null) return { data: null, error: { message: 'readAll: no request was made' } };
  if (!complete) {
    return {
      data: null,
      error: { message: `readAll: incomplete read - gave up after ${MAX_PAGES} pages` },
      status: last.status,
    };
  }
  return { data: rows, error: null, status: last.status };
}

/* ---------- Render order, imposed here rather than taken from the server ---- */
//
// Paging walks `id`, so the server no longer hands rows back in display order.
// These restore exactly the order the five queries used to ask it for. Postgres
// sorts NULLs LAST ascending and FIRST descending, and these match that; each
// breaks ties on `id` so the order is TOTAL, where the server left ties
// arbitrary - which is what used to make lists shuffle between pulls.
const cmpAsc = (a: string | number | null, b: string | number | null): number => {
  if (a === b) return 0;
  if (a === null) return 1;   // NULLS LAST ascending
  if (b === null) return -1;
  return a < b ? -1 : 1;
};
const byAsc = (col: string) => (x: any, y: any): number =>
  cmpAsc(x[col] ?? null, y[col] ?? null) || cmpAsc(x.id, y.id);
const byDesc = (col: string) => (x: any, y: any): number => {
  const a = x[col] ?? null, b = y[col] ?? null;
  if (a === b) return cmpAsc(x.id, y.id);
  if (a === null) return -1;  // NULLS FIRST descending
  if (b === null) return 1;
  return a < b ? 1 : -1;
};
// Events keep the (ts, id) key the client sorts by - see compareEvents. Undo
// means "the last event of this game", so both sides must name the same row.
const byTsThenId = (x: any, y: any): number => cmpAsc(x.ts, y.ts) || cmpAsc(x.id, y.id);

/**
 * A server snapshot, and WHICH LEAGUES IT SPEAKS FOR.
 *
 * `covered: null` means "every league, in full" - the only kind of snapshot
 * this app has ever taken. It is a separate field rather than an implication of
 * the data because the absence of rows cannot carry that meaning: a league with
 * no events and a league whose events were not requested look identical in a
 * result set, and treating the second as the first is how HYDRATE deletes a
 * scorekeeper's game (see N-39). Anything that decides a local row is gone
 * because the server did not mention it MUST first ask whether the server was
 * asked about it.
 */
export interface StateSnapshot {
  leagues: League[];
  /** League ids this snapshot's heavy tables cover, or null for "all of them". */
  covered: readonly string[] | null;
}

/**
 * The leagues whose heavy tables a pull should read, or null for all of them.
 *
 * `[]` is meaningful and is NOT the same as null: a device with no leagues of
 * its own reads the catalogue and nothing else, which is exactly right and
 * costs four fewer requests.
 */
export type PullScope = readonly string[] | null;

/**
 * Which leagues this account runs, from `my_memberships()`.
 *
 * Returns null when the answer could not be obtained, which the caller must
 * treat as "unknown", not "none" - dropping a scorekeeper's own league out of
 * the pull because an RPC failed is how their game stops syncing.
 */
export async function fetchMemberships(sb: SupabaseClient): Promise<string[] | null> {
  const res = await sb.rpc('my_memberships');
  const transport = transportFailure(res as { error: unknown; status?: number });
  if (transport !== null) throw new Error(`fetch memberships: ${transport}`);
  if (res.error) {
    warn('[sync] my_memberships failed:', res.error.message);
    return null;
  }
  const rows = res.data as { league_id?: string }[] | null;
  if (!Array.isArray(rows)) return null;
  return rows.map(r => r?.league_id).filter((id): id is string => typeof id === 'string');
}

export async function fetchAllState(sb: SupabaseClient, scope: PullScope = null): Promise<StateSnapshot | null> {
  // Every read WALKS THE WHOLE TABLE by `id`, a page at a time - see readAll.
  // The cursor IS the ordering: `.order('id')` is what makes "everything after
  // this id" well defined, and it is deliberately NOT the display order, which
  // OFFSET paging depended on and which any concurrent write could shift under
  // it. Display order is imposed below, on the rows already in hand.
  const byKeyset = (table: 'leagues' | 'teams' | 'players' | 'games' | 'events') =>
    readAll((after, limit) => {
      let q = sb.from(table).select('*').order('id').limit(limit);
      // The CATALOGUE is never scoped: one row per league, and browsing every
      // league is the product. Only the four heavy tables are narrowed.
      if (scope !== null && table !== 'leagues') q = q.in('league_id', scope as string[]);
      return after === null ? q : q.gt('id', after);
    });

  // An empty scope has nothing to ask about, and `.in('league_id', [])` is a
  // request whose answer is known. Skip it rather than spend four round trips
  // being told nothing.
  const empty = { data: [] as unknown[], error: null };
  const heavy = () => scope !== null && scope.length === 0
    ? [empty, empty, empty, empty]
    : [byKeyset('teams'), byKeyset('players'), byKeyset('games'), byKeyset('events')];
  const [lr, tr, pr, gr, er] = await Promise.all([byKeyset('leagues'), ...heavy()]);

  // TRANSPORT FIRST, and it REJECTS rather than returning null.
  //
  // `null` cannot say which of two very different things happened. "The host
  // answered and something was wrong with the read" is one; "nothing came back
  // at all" is the other, and only the second means the device is offline. The
  // caller could not tell them apart, so `pullState` called `noteReachable()`
  // on the line after this returned - recording a five-table read that never
  // left the device as proof the server was up. That is what kept Settings
  // showing "Connected" in aeroplane mode and made pull-to-refresh answer
  // 'refreshed' with nothing fetched.
  //
  // Row-level problems still return null, unchanged: those did reach the
  // server, and the caller's existing "no snapshot this time" handling is the
  // right response to them.
  const reads = [
    ['leagues', lr], ['teams', tr], ['players', pr], ['games', gr], ['events', er],
  ] as const;
  for (const [what, res] of reads) {
    const transport = transportFailure(res);
    if (transport !== null) throw new Error(`fetch ${what}: ${transport}`);
  }

  if (lr.error) { warn('[sync] fetch leagues error:', lr.error.message); return null; }
  if (tr.error || pr.error || gr.error || er.error) {
    warn('[sync] fetch error:', tr.error?.message ?? pr.error?.message ?? gr.error?.message ?? er.error?.message);
    return null;
  }

  // The order the five queries used to ask the server for, applied to the rows
  // the keyset walk returned. Sorting once here costs one pass per table and
  // keeps every consumer's assumptions about render order intact.
  const leagueRows = (lr.data as LeagueRow[]).slice().sort(byDesc('created_at'));  // newest first, matches local prepend
  const teamRows   = (tr.data as TeamRow[]).slice().sort(byAsc('name'));           // alphabetical, matches render order
  const playerRows = (pr.data as PlayerRow[]).slice().sort(byAsc('name'));
  const gameRows   = (gr.data as GameRow[]).slice().sort(byDesc('scheduled_at'));
  const eventRows  = (er.data as EventRow[]).slice().sort(byTsThenId);

  const leagues = leagueRows.map(lRow => {
    const teams   = teamRows.filter(x => x.league_id === lRow.id).map(teamFromRow);
    const players = playerRows.filter(x => x.league_id === lRow.id).map(playerFromRow);
    const games   = gameRows.filter(x => x.league_id === lRow.id).map(gameFromRow);
    const events  = eventRows.filter(x => x.league_id === lRow.id).map(eventFromRow);
    return leagueFromRow(lRow, teams, players, games, events);
  });

  // The scope travels WITH the rows, so HYDRATE knows which leagues this
  // snapshot is entitled to speak for. Everything outside it keeps whatever the
  // device already has - see StateSnapshot.
  return { leagues, covered: scope };
}

/**
 * Read ONE league's heavy tables, for a league opened from the catalogue.
 *
 * The same keyset walk as `fetchAllState`, filtered to one league_id, and the
 * returned snapshot covers exactly that league - so HYDRATE reconciles this
 * league and leaves every other one alone. The league row itself is not
 * re-read: the catalogue already has it, and re-reading it would let a stale
 * copy of the scalars overwrite a rename that has not been pulled yet.
 */
export async function fetchLeagueDetail(
  sb: SupabaseClient,
  leagueId: string,
): Promise<{ teams: Team[]; players: Player[]; games: Game[]; events: GameEvent[] } | null> {
  const forLeague = (table: 'teams' | 'players' | 'games' | 'events') =>
    readAll((after, limit) => {
      const q = sb.from(table).select('*').eq('league_id', leagueId).order('id').limit(limit);
      return after === null ? q : q.gt('id', after);
    });
  const [tr, pr, gr, er] = await Promise.all([
    forLeague('teams'), forLeague('players'), forLeague('games'), forLeague('events'),
  ]);

  // Transport first and it REJECTS, exactly as fetchAllState does: "nothing
  // came back at all" is the only thing that means offline.
  for (const [what, res] of [['teams', tr], ['players', pr], ['games', gr], ['events', er]] as const) {
    const transport = transportFailure(res);
    if (transport !== null) throw new Error(`fetch ${what} for ${leagueId}: ${transport}`);
  }
  if (tr.error || pr.error || gr.error || er.error) {
    warn('[sync] fetch league detail error:',
      tr.error?.message ?? pr.error?.message ?? gr.error?.message ?? er.error?.message);
    return null;
  }

  return {
    teams: (tr.data as TeamRow[]).slice().sort(byAsc('name')).map(teamFromRow),
    players: (pr.data as PlayerRow[]).slice().sort(byAsc('name')).map(playerFromRow),
    games: (gr.data as GameRow[]).slice().sort(byDesc('scheduled_at')).map(gameFromRow),
    events: (er.data as EventRow[]).slice().sort(byTsThenId).map(eventFromRow),
  };
}

/**
 * A live game in a league this device has not loaded.
 *
 * Everything the Home banner draws and NOTHING ELSE: it renders the league
 * name, the matchup and the location - no score - so this read does not touch
 * the events table at all. Kept as a flat projection rather than merged into
 * the league objects, deliberately: half-populating an unloaded league is how a
 * screen ends up computing standings off three of its games. Nothing persists
 * it and nothing else reads it.
 */
export interface LiveElsewhere {
  leagueId: string;
  gameId: string;
  homeName: string | null;
  awayName: string | null;
  location: string | null;
}

/**
 * Every live game, in every league, however little of the database is loaded.
 *
 * This is the one cross-league read that survives scoping, because a fan
 * browsing for something to watch is the point of the banner. It stays cheap
 * because "live" is a tiny slice: a handful of rows on the busiest Saturday,
 * plus the teams they name.
 */
export async function fetchLiveGames(sb: SupabaseClient): Promise<LiveElsewhere[] | null> {
  const gr = await readAll((after, limit) => {
    const q = sb.from('games').select('*').eq('status', 'live').order('id').limit(limit);
    return after === null ? q : q.gt('id', after);
  });
  const transportG = transportFailure(gr);
  if (transportG !== null) throw new Error(`fetch live games: ${transportG}`);
  if (gr.error) { warn('[sync] fetch live games error:', gr.error.message); return null; }

  const games = gr.data as GameRow[];
  if (games.length === 0) return [];

  // Only the teams these games actually name. Two ids per game, so this is
  // bounded by the number of live games rather than by the size of the table.
  const teamIds = [...new Set(games.flatMap(g => [g.home_team_id, g.away_team_id]).filter(Boolean))];
  const tr = await readAll((after, limit) => {
    const q = sb.from('teams').select('*').in('id', teamIds).order('id').limit(limit);
    return after === null ? q : q.gt('id', after);
  });
  const transportT = transportFailure(tr);
  if (transportT !== null) throw new Error(`fetch live game teams: ${transportT}`);
  if (tr.error) { warn('[sync] fetch live game teams error:', tr.error.message); return null; }

  const nameOf = new Map((tr.data as TeamRow[]).map(t => [t.id, t.name]));
  return games.map(g => ({
    leagueId: g.league_id,
    gameId: g.id,
    homeName: nameOf.get(g.home_team_id) ?? null,
    awayName: nameOf.get(g.away_team_id) ?? null,
    location: g.location ?? null,
  }));
}

/* ---------- Push: mirror an action's effect to Supabase --------------------- */
// We translate the *intent* of each action to a row-level operation. The post-
// reducer `state` is passed in so we can look up the new shape of things (e.g.
// after ADD_PLAYER we read the team's updated playerIds and upsert the team).

/**
 * Did this response come back from the host at all?
 *
 * THE ASSUMPTION THIS REPLACES, AND WHY IT COST DATA.
 *
 * Every comment in this file used to say that a network failure "arrives as a
 * throw". It does not. The installed @supabase/postgrest-js catches the fetch
 * rejection and RESOLVES with `{ data: null, error, status: 0 }` - nothing here
 * calls `throwOnError()` and `getSupabase()` installs no custom fetch, so that
 * is the shape the app really sees. Verified against this repository's own
 * node_modules: a select and an upsert against an unreachable host both resolve
 * with status 0 and `error.message` of `TypeError: fetch failed`.
 *
 * So `check` swallowed it, `pushAction` returned normally, and the ledger was
 * told the server had a write that never left the device. Every action that
 * pushes through `check` - a lineup, a substitution, attendance, the period,
 * the game status - reported success with the connection down, was marked
 * confirmed, and was therefore never queued, never persisted and never retried.
 * The next snapshot after reconnect handed back the stale server row.
 *
 * `status === 0` is the primary signal because postgrest-js sets it in exactly
 * one place: the branch that catches the fetch rejection. It is also the only
 * one that catches a TIMEOUT, whose message is `AbortError: ...` and reads like
 * nothing at all. The message test stays as well, because it is what the test
 * harness and any client that does not carry a status can offer.
 *
 * Returns the message to report, worded so that `isNetworkFailure` still
 * recognises it after it has been through an Error - `noteUnreachable` and
 * `pushAction`'s own guard both classify by message, and a status cannot be
 * carried on a throw.
 */
function transportFailure(res: { error?: any; status?: number } | null | undefined): string | null {
  if (!res?.error) return null;
  const msg = res.error.message ?? String(res.error);
  if (isNetworkFailure(msg)) return msg;
  if (res.status === 0) return `Network request failed - ${msg}`;
  return null;
}

// Logs PostgREST/RLS-style errors from a Supabase response, and rethrows the
// ones that mean the request never arrived.
//
// A ROW-LEVEL rejection keeps the old behaviour deliberately: the server was
// reached, it made a decision, and a non-critical write can reconverge on the
// next pull rather than interrupting a live game. A TRANSPORT failure cannot -
// it wrote nothing, for any action, so resolving it is always a false 'saved'.
// The fix lives here rather than in the list of critical actions because the
// mechanism is the response, not the action: fixing it at the call sites would
// leave every helper that inspects a response free to swallow it again.
//
// `any` is deliberate: this only ever reads .error off an arbitrary PostgREST
// response shape, and narrowing it would mean restating every response type.
function check(label: string, res: { error: any; status?: number }): void {
  if (!res?.error) return;
  const transport = transportFailure(res);
  if (transport !== null) {
    warn(`[sync] ${label} FAILED:`, transport);
    throw new Error(`${label}: ${transport}`);
  }
  warn(`[sync] ${label} rejected:`, res.error.message ?? res.error);
}

// For writes where a silent failure means the user LOSES data they can see on
// screen (creating a drop-in game, importing a roster). These rethrow so the
// sync badge shows 'error' instead of falsely reporting 'saved' while the
// server has nothing — the failure mode that hid the drop-in game bugs.
function checkCritical(label: string, res: { error: any; status?: number }): void {
  if (res?.error) {
    const msg = transportFailure(res) ?? (res.error.message ?? String(res.error));
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
    // Keyed off the action, and off the TRANSPORT.
    //
    // A request that never reached the host wrote nothing, for any action, so
    // resolving it is always a false 'saved'. That mattered little while a
    // resolved push only meant "stop showing the spinner"; it matters a great
    // deal now that it also means "the outbox may let this go". A lineup, a
    // substitution, the period and the game status all push through `check`.
    //
    // This clause was DEAD until `check` was fixed: it lives in a catch, and
    // nothing ever threw, because the transport failure resolved into `.error`
    // where `check` logged it and returned. So with the connection down every
    // one of those writes reported success, was marked confirmed, and was never
    // queued or retried - an offline substitution simply did not exist as far
    // as the server was ever concerned. `check` now rethrows a transport
    // failure, which is what reaches this line. The clause stays because it is
    // the layer that decides, and because a client that REJECTS rather than
    // resolving lands here without passing through `check` at all.
    //
    // Row-level rejections keep the old behaviour: those DID reach the server,
    // the server made a decision, and a non-critical one can still reconverge
    // on the next pull rather than interrupting a live game.
    if (MUST_NOT_FAIL_SILENTLY.has(action.t) || isNetworkFailure(msg)) throw e;
  }
}

/* ---------- Replay: re-send an outbox entry ---------------------------------
 *
 * `pushAction` mirrors an ACTION, and an action is a thing that happened at a
 * moment, against the state at that moment. That is the right shape for a write
 * issued as the person taps, and the wrong shape for one re-sent an hour later:
 * `ADD_EVENT` looks the row up in the state handed to it, and it INSERTs, so a
 * retry of a write that did land (the request succeeded, the reply was lost)
 * comes back as a duplicate-key rejection - a permanent failure, on a stat that
 * is in fact perfectly saved.
 *
 * Replay is by ROW instead, and every operation is idempotent:
 *
 *   add     upsert on a client-generated id  - present already? no-op.
 *   remove  delete .eq(id)                   - gone already? no-op.
 *   game    upsert the whole row             - the same write the live path makes.
 *
 * That is what makes "retry until it sticks" safe, and it is the answer to
 * duplicate stats: the id was minted on the device before the first attempt, so
 * every attempt names the same row. `events` and `games` both carry a
 * `for all` RLS policy (schema.sql), so the update half of an upsert is
 * permitted for anyone allowed to write the row at all.
 *
 * Failures are rethrown. The caller keeps the entry, counts the attempt, and
 * tries again later - an outbox that swallowed a rejection would be back to
 * reporting a save that did not happen.
 */
export async function pushPendingEntry(sb: SupabaseClient, entry: OutboxEntry): Promise<void> {
  if (entry.kind === 'game') {
    if (!entry.game) return;
    checkCritical('REPLAY_games', await sb.from('games').upsert(gameToRow(entry.game)));
    return;
  }
  if (entry.op === 'add') {
    const ev = entry.event;
    if (!ev) return;
    checkCritical('REPLAY_events', await sb.from('events').upsert({
      id: ev.id, league_id: entry.leagueId, game_id: ev.gameId, team_id: ev.teamId,
      player_id: ev.playerId, type: ev.type, period: ev.period, ts: ev.ts, note: ev.note ?? null,
    }));
    return;
  }
  // A removal. Same care as UNDO_EVENT's delete: PostgREST reports no error when
  // row-level security hides the rows a DELETE targeted, so ask for the removed
  // rows back and, when none came, check whether the row is still there. Gone
  // means the delete has nothing left to do; still present means it was refused,
  // and the entry has to stay in the outbox rather than report a success.
  if (!entry.eventId) return;
  const res = await sb.from('events').delete().eq('id', entry.eventId).select('id');
  if (res.error) checkCritical('REPLAY_delete_events', res);
  else if ((res.data ?? []).length === 0) {
    const back = await sb.from('events').select('id').eq('id', entry.eventId);
    if (!back.error && (back.data ?? []).length > 0) {
      throw new Error(`REPLAY_delete_events: server refused to delete event ${entry.eventId}`);
    }
  }
}

/**
 * Is the server answering?
 *
 * The cheapest read the schema allows, used only while the app believes it is
 * offline. It asks nothing about the DATA - an empty result is a perfectly good
 * answer, and under row-level security a common one - only whether the request
 * came back at all, which is the entire question `connectivity.ts` needs.
 *
 * A row-level rejection resolves `true` for the same reason: something answered.
 * Only a transport failure means unreachable - and it does NOT arrive as a
 * throw, which is what this function used to be built on. postgrest-js resolves
 * it with `status: 0` and an error object, so the old `catch` never ran and the
 * probe answered "reachable" in aeroplane mode. It therefore decides from the
 * RESPONSE. The `catch` is kept for a client that does reject (an older
 * transport, a custom fetch): nothing came back there either.
 */
export async function pingServer(sb: SupabaseClient): Promise<boolean> {
  try {
    const res = await sb.from('leagues').select('id').limit(1);
    return transportFailure(res) === null;
  } catch {
    return false;
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
