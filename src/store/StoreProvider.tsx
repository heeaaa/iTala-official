import { Alert } from 'react-native';
import React, { createContext, useContext, useEffect, useReducer, useRef, useCallback } from 'react';
import { AppState, League, Team, Player, Game, GameEvent, EventType, LocalPrefs, LegacyPersistedSettings } from '../types';
import { setHapticsEnabled } from '../lib/haptics';
import { ensureNotifPermission } from '../lib/notify';
import { uid } from '../lib/format';
import { teamColors, DEFAULT_FOUL_OUT } from '../theme';
import { loadState, saveState, loadPrefs, savePrefs } from './storage';
import { getSupabase, SYNC_ENABLED } from '../sync/supabase';
import { fetchAllState, pushAction, subscribeRealtime } from '../sync/sync';
import { enqueuePush, __resetPushQueue } from '../sync/pushQueue';
import {
  acceptSnapshot, appliedSnapshotAt, beginSnapshot, confirmPending, failPending,
  insertEvent, lastEventOf, recordPending, reconcileLeagueEvents,
  reconcileLeagueGames, sortEvents, __resetPending,
} from '../sync/pendingEvents';
import { trace, warn } from '../lib/log';
import { isNetworkFailure } from './authErrors';

/**
 * Resolve once the client has a session, or once `ms` have passed.
 *
 * Event-driven: one getSession() read, then a subscription. Polling getSession()
 * in a loop is both wasteful and actively harmful — every call goes through
 * supabase-js's auth initialisation, so a stalled network turns a poll into a
 * queue of stalled calls that starve the sign-in the loop is waiting for.
 */
async function waitForSession(sb: NonNullable<ReturnType<typeof getSupabase>>, ms: number): Promise<boolean> {
  try {
    const { data } = await sb.auth.getSession();
    if (data.session) return true;
  } catch {
    // A failed read is not a failed wait: the subscription below may still fire.
  }
  return new Promise<boolean>(resolve => {
    let done = false;
    // `let`, declared first, and assigned after subscribing. A callback that
    // fires during the subscribe call would otherwise read this binding inside
    // its temporal dead zone - a ReferenceError, which `?.` does not protect
    // against because the reference itself is what throws.
    let sub: { unsubscribe: () => void } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (got: boolean) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      sub?.unsubscribe();
      resolve(got);
    };
    timer = setTimeout(() => finish(false), ms);
    sub = sb.auth.onAuthStateChange((_e, s) => { if (s) finish(true); }).data.subscription;
    // If the callback already resolved us, the subscription above was created
    // after finish() ran and would otherwise leak.
    if (done) sub.unsubscribe();
  });
}

/** A sync failure, said in a way that points at the right thing to check. */
function describeSyncFailure(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e ?? '');
  if (isNetworkFailure(msg)) {
    return "The app couldn't reach the server. Check this device's connection and try again.";
  }
  if (/sign in to start a drop-in game/i.test(msg)) {
    return 'Starting a drop-in game needs an account. Sign in and try again.';
  }
  if (/scorekeeper access required/i.test(msg)) {
    return "You don't have scoring rights in that space.";
  }
  return msg;
}

// Lineups, substitutions, the period and the game status are no longer guarded
// by a clock here. They go into the same pending-writes ledger as the events
// (see sync/pendingEvents.ts, `pendingGameWrite`), so a substitution keeps the
// ordering guarantee a basket gets instead of a 2.5-second tombstone that was
// both too short for a slow push and wrong the moment it expired.

// Freshly-created-bundle guard. A local write (e.g. starting a drop-in game)
// is visible locally immediately, but the server round trip takes a moment. If
// a realtime refetch lands in that window, the incoming snapshot won't contain
// the new game/teams/players and a naive HYDRATE would DELETE them locally —
// which is what made drop-in games show a "?" team and crash the live card.
// While a bundle is guarded, HYDRATE re-adds any of its rows the snapshot is
// missing instead of dropping them.
interface PendingBundle { leagueId: string; expires: number; gameIds: string[]; teamIds: string[]; playerIds: string[] }
const bundleGuard: PendingBundle[] = [];
const BUNDLE_GUARD_MS = 12000; // generous: covers slow connections
function guardBundle(b: Omit<PendingBundle, 'expires'>) {
  bundleGuard.push({ ...b, expires: Date.now() + BUNDLE_GUARD_MS });
}
function activeBundles(): PendingBundle[] {
  const now = Date.now();
  for (let i = bundleGuard.length - 1; i >= 0; i--) {
    if (bundleGuard[i].expires < now) bundleGuard.splice(i, 1);
  }
  return bundleGuard;
}

// Event reconciliation is NOT a timed guard — see sync/pendingEvents.ts. Local
// event writes go into a ledger keyed by event id and are retired only once a
// snapshot is known to have been read AFTER the server confirmed them. The
// 12-second undo tombstone this replaced covered undone events only, left a
// pending INSERT (i.e. the scoreboard) completely unprotected, and flipped its
// answer the moment its clock ran out.

interface RecTeamInput { id: string; name: string; color?: string; players: { id: string; name: string; number?: string }[] }

/** What one server pull did. `applied` is whether local state moved; `hadData`
 *  is whether the server returned any league at all, which is the question boot
 *  has to keep retrying on - an empty read may only mean the session wasn't
 *  ready yet, and looks identical to an account that genuinely owns nothing. */
interface PullResult { applied: boolean; hadData: boolean }

export type Action =
  // `settings` is the legacy app-wide toggle. It is no longer part of AppState,
  // but a saved state loaded off an older build still carries it, so the shape
  // is declared here and read once by the HYDRATE case below.
  | {
      t: 'HYDRATE';
      state: AppState & { settings?: LegacyPersistedSettings };
      /** Tick from `beginSnapshot()`, taken BEFORE the fetch that produced this
       *  state. Present only for server snapshots; a hydrate from local storage
       *  has no server rows to reconcile against and omits it. */
      snapshotAt?: number;
    }
  | { t: 'ADD_LEAGUE'; id: string; name: string; season: string; foulOutLimit?: number; kind?: 'league' | 'recreational'; trackMisses?: boolean; trackTurnovers?: boolean; isShared?: boolean; creationCode?: string }
  | { t: 'DELETE_LEAGUE'; leagueId: string }
  | { t: 'ADD_TEAM'; leagueId: string; name: string; teamOnly?: boolean; id?: string }
  | { t: 'BULK_IMPORT_ROSTER'; leagueId: string; teams: { id: string; name: string; players: { id: string; name: string; number?: string }[] }[] }
  | { t: 'UPDATE_TEAM'; leagueId: string; teamId: string; name?: string; color?: string; logo?: string | null; coach?: string | null }
  | { t: 'DELETE_TEAM'; leagueId: string; teamId: string }
  | { t: 'ADD_PLAYER'; leagueId: string; teamId: string; name: string; number?: string; id?: string }
  | { t: 'UPDATE_PLAYER'; leagueId: string; playerId: string; name?: string; number?: string | null }
  | { t: 'DELETE_PLAYER'; leagueId: string; teamId: string; playerId: string }
  | { t: 'CREATE_GAME'; id: string; leagueId: string; homeTeamId: string; awayTeamId: string; location?: string; homeOnCourt?: string[]; awayOnCourt?: string[] }
  | { t: 'SET_LINEUP'; leagueId: string; gameId: string; side: 'home' | 'away'; playerIds: string[] }
  | { t: 'SET_LINEUPS'; leagueId: string; gameId: string; home: string[]; away: string[] }
  | { t: 'SUBSTITUTE'; leagueId: string; gameId: string; side: 'home' | 'away'; outId: string; inId: string }
  // `id` and `ts` on ADD_EVENT, and `eventId` on UNDO/REDO, are filled in by
  // stampActionIds at dispatch time. Callers leave them out; the reducer, the
  // sync push and the pending ledger then all name the same row, with the same
  // timestamp.
  | { t: 'ADD_EVENT'; leagueId: string; gameId: string; teamId: string; playerId: string | null; type: EventType; period: number; note?: string; id?: string; ts?: number }
  | { t: 'UNDO_EVENT'; leagueId: string; gameId: string; eventId?: string }
  | { t: 'REDO_EVENT'; leagueId: string; gameId: string; eventId?: string }
  | { t: 'DELETE_EVENT'; leagueId: string; gameId: string; eventId: string }
  | { t: 'DELETE_GAME'; leagueId: string; gameId: string }
  | { t: 'CLEANUP_REC_GAMES'; leagueId: string; gameIds: string[] }
  | { t: 'SET_GAME_STATUS'; leagueId: string; gameId: string; status: Game['status'] }
  | { t: 'SET_ATTENDANCE'; leagueId: string; gameId: string; playerIds: string[] }
  | { t: 'SET_PERIOD'; leagueId: string; gameId: string; period: number }
  | { t: 'DUPLICATE_LEAGUE'; sourceLeagueId: string; newLeagueId: string; name: string; season: string }
  | { t: 'SET_LEAGUE_SETTINGS'; leagueId: string; trackMisses?: boolean; trackTurnovers?: boolean; isClosed?: boolean; isArchived?: boolean }
  | { t: 'REC_SETUP_GAME'; leagueId: string; gameId: string; location?: string; trackMisses?: boolean; trackTurnovers?: boolean; createdBy?: string; ensureLeague?: { name: string; isShared?: boolean }; teams: [RecTeamInput, RecTeamInput] }
  // Undo the local half of an all-or-nothing bundle whose server write failed.
  // Local-only: the rows this removes never reached the server, so there is
  // nothing to delete there and nothing to push. See the dispatch wrapper.
  | { t: 'ROLLBACK_BUNDLE'; leagueId: string; gameIds: string[]; teamIds: string[]; playerIds: string[]; removeLeague?: boolean }

const initial: AppState = { leagues: [] };

function mapLeague(state: AppState, id: string, fn: (l: League) => League): AppState {
  return { ...state, leagues: state.leagues.map(l => (l.id === id ? fn(l) : l)) };
}

// Fouls needed to foul out. Mirrors effectiveFoulLimit() in lib/stats; kept here
// so the reducer has no import cycle with the stats engine.
function foulLimitOf(l: League): number {
  const stored = l.foulOutLimit;
  return (!stored || stored > DEFAULT_FOUL_OUT) ? DEFAULT_FOUL_OUT : stored;
}

/**
 * Give every event-mutating action a concrete event id BEFORE it is reduced.
 *
 * Three consumers need to agree on which row an action is about: the reducer,
 * the sync push, and the pending ledger. Two of them used to work it out by
 * looking at the resulting array — "the last event of this game" for undo, and
 * `events[events.length - 1]` for the push — which only held while events were
 * appended in arrival order. They are now kept in canonical (ts, id) order so
 * the local list matches the server's, and a redone event lands back in its own
 * place rather than at the end. Position-based lookups do not survive that, and
 * they were fragile anyway: an id resolved here, once, from the PRE-dispatch
 * state is unambiguous for all three.
 *
 *   ADD_EVENT   → mint the new id, and stamp the timestamp
 *   UNDO_EVENT  → the canonical last event of the game
 *   REDO_EVENT  → the event on top of the redo stack
 *
 * `ts` is stamped here for the same reason, and it matters more than it looks.
 * The reducer runs TWICE per action in this app: once in the dispatch wrapper
 * below, to compute the rows the server push mirrors, and again inside React's
 * useReducer for the state the UI renders (React may also re-run a reducer for
 * an action whose update it re-bases). `ts: Date.now()` inside the reducer
 * therefore produced a DIFFERENT timestamp in each run - the row on the server
 * and the row on screen disagreed by a millisecond or two. `ts` is half of the
 * (ts, id) key that makes "the last event of this game" mean the same row on
 * both sides, which is the entire definition of Undo, so the two must not be
 * allowed to drift. Resolved once, here, from the action.
 *
 * And `ts` is taken as strictly AFTER every event already logged for this game,
 * not simply as the clock reading. Six taps in one burst land inside the same
 * millisecond, `ts` ties, and the (ts, id) order then falls back to comparing
 * random ids - so "the last event of this game" became whichever of the six
 * happened to sort last, and Undo removed a stat the scorekeeper did not just
 * enter. Ties are prevented at the source instead. The id tie-break stays as the
 * backstop for rows this device did not mint (two devices inside one
 * millisecond, and rows already stored by an older build).
 *
 * Exported so the sync tests exercise the same resolution the app uses rather
 * than a copy of it.
 */
export function stampActionIds(state: AppState, action: Action): Action {
  if (action.t === 'ADD_EVENT') {
    if (action.id !== undefined && action.ts !== undefined) return action;
    const lg = state.leagues.find(l => l.id === action.leagueId);
    const latest = lastEventOf(lg?.events ?? [], action.gameId);
    return {
      ...action,
      id: action.id ?? uid(),
      ts: action.ts ?? Math.max(Date.now(), (latest?.ts ?? 0) + 1),
    };
  }
  if (action.t === 'UNDO_EVENT') {
    if (action.eventId) return action;
    const lg = state.leagues.find(l => l.id === action.leagueId);
    const last = lastEventOf(lg?.events ?? [], action.gameId);
    return last ? { ...action, eventId: last.id } : action;
  }
  if (action.t === 'REDO_EVENT') {
    if (action.eventId) return action;
    const lg = state.leagues.find(l => l.id === action.leagueId);
    const stack = lg?._redo?.[action.gameId] ?? [];
    const top = stack[stack.length - 1];
    return top ? { ...action, eventId: top.id } : action;
  }
  return action;
}

/** Test hook: clear module-level guards and the push chain between suites. */
export function __resetSyncPrimitives(): void {
  __resetPending();
  bundleGuard.length = 0;
  __resetPushQueue();
}

export function reducer(state: AppState, a: Action): AppState {
  switch (a.t) {
    case 'HYDRATE': {
      // LEGACY MIGRATION. Saved states written before leagues.track_misses
      // existed carry an app-wide toggle instead. Read it once here to seed any
      // league that predates the per-league column, then never again: nothing
      // writes it, and it stopped being persisted when it left AppState. The
      // `true` default matches the old defaultSettings value, so a device that
      // never set it is unaffected.
      const legacyTrackMisses = a.state.settings?.trackMisses ?? true;

      const bundles = activeBundles();
      const localLeagues = new Map(state.leagues.map(l => [l.id, l]));

      const leagues = a.state.leagues.map(l => {
        // Reconcile the snapshot's events against local writes the server has
        // not demonstrably applied yet. `snapshotAt` is the tick taken before
        // the fetch; without one this is a hydrate from local storage, which
        // has no server rows to reconcile and is simply put in canonical order.
        // See sync/pendingEvents.ts — this is what stops a stale snapshot from
        // reverting a just-tapped basket (and then double-counting it).
        const events = a.snapshotAt === undefined
          ? sortEvents(l.events)
          : reconcileLeagueEvents(l.id, l.events, a.snapshotAt);
        const reconciled = { ...l, events };
        const migrated = reconciled.trackMisses === undefined
          ? { ...reconciled, trackMisses: legacyTrackMisses }
          : reconciled;
        // Same reconciliation for the game rows: a lineup, substitution, period
        // or status written locally stays authoritative until a snapshot read
        // after the server confirmed it. The local rows go in too, so a pending
        // write for a game the device no longer has (a rolled-back drop-in, a
        // deleted game) is discarded rather than re-added.
        const games = a.snapshotAt === undefined
          ? migrated.games
          : reconcileLeagueGames(l.id, migrated.games, a.snapshotAt, localLeagues.get(l.id)?.games);
        // _redo is local-only and never present in a server snapshot, so it
        // must be carried across or every background sync would clear it.
        let out: League = { ...migrated, games, _redo: localLeagues.get(l.id)?._redo };

        // Re-add anything a guarded bundle owns that the server snapshot
        // hasn't caught up on yet, so a mid-write refetch can't delete a
        // just-created game or leave it pointing at missing teams.
        for (const b of bundles) {
          if (b.leagueId !== out.id) continue;
          const local = localLeagues.get(out.id);
          if (!local) continue;
          const haveGames = new Set(out.games.map(x => x.id));
          const haveTeams = new Set(out.teams.map(x => x.id));
          const havePlayers = new Set(out.players.map(x => x.id));
          out = {
            ...out,
            games: [...local.games.filter(x => b.gameIds.includes(x.id) && !haveGames.has(x.id)), ...out.games],
            teams: [...out.teams, ...local.teams.filter(x => b.teamIds.includes(x.id) && !haveTeams.has(x.id))],
            players: [...out.players, ...local.players.filter(x => b.playerIds.includes(x.id) && !havePlayers.has(x.id))],
          };
        }
        return out;
      });

      // A guarded bundle may belong to a league the snapshot doesn't have at
      // all yet (a brand-new private drop-in space) — keep that league whole.
      const serverIds = new Set(leagues.map(l => l.id));
      const rescued = bundles
        .filter(b => !serverIds.has(b.leagueId))
        .map(b => localLeagues.get(b.leagueId))
        .filter((l): l is League => !!l);

      return { leagues: [...rescued, ...leagues] };
    }

    case 'ADD_LEAGUE': {
      const league: League = {
        id: a.id, name: a.name.trim() || 'New League', season: a.season.trim() || 'Season 1',
        kind: a.kind ?? 'league',
        foulOutLimit: a.foulOutLimit ?? DEFAULT_FOUL_OUT,
        trackMisses: a.trackMisses ?? true,
        trackTurnovers: a.trackTurnovers ?? true,
        isShared: a.isShared || undefined,
        teams: [], players: [], games: [], events: [], createdAt: Date.now(),
      };
      return { ...state, leagues: [league, ...state.leagues] };
    }

    case 'DELETE_LEAGUE':
      return { ...state, leagues: state.leagues.filter(l => l.id !== a.leagueId) };

    case 'ADD_TEAM':
      return mapLeague(state, a.leagueId, l => {
        const team: Team = {
          id: a.id ?? uid(), name: a.name.trim() || `Team ${l.teams.length + 1}`,
          color: teamColors[l.teams.length % teamColors.length],
          playerIds: [], teamOnly: a.teamOnly,
        };
        return { ...l, teams: [...l.teams, team] };
      });

    case 'UPDATE_TEAM':
      return mapLeague(state, a.leagueId, l => ({
        ...l,
        teams: l.teams.map(t => {
          if (t.id !== a.teamId) return t;
          const next: Team = { ...t };
          if (a.name !== undefined) next.name = a.name.trim() || t.name;
          if (a.color !== undefined) next.color = a.color;
          if (a.coach !== undefined) next.coach = a.coach?.trim() || undefined;
          if (a.logo !== undefined) next.logo = a.logo === null ? undefined : a.logo;
          return next;
        }),
      }));

    case 'DELETE_TEAM':
      return mapLeague(state, a.leagueId, l => ({
        ...l,
        teams: l.teams.filter(t => t.id !== a.teamId),
        // remove games involving this team and their events
        games: l.games.filter(g => g.homeTeamId !== a.teamId && g.awayTeamId !== a.teamId),
        events: l.events.filter(e => e.teamId !== a.teamId),
      }));

    case 'ADD_PLAYER':
      return mapLeague(state, a.leagueId, l => {
        const player: Player = { id: a.id ?? uid(), name: a.name.trim() || 'Player', number: a.number };
        return {
          ...l,
          players: [...l.players, player],
          teams: l.teams.map(t =>
            t.id === a.teamId ? { ...t, playerIds: [...t.playerIds, player.id] } : t
          ),
        };
      });

    case 'UPDATE_PLAYER':
      return mapLeague(state, a.leagueId, l => ({
        ...l,
        players: l.players.map(p => {
          if (p.id !== a.playerId) return p;
          const next: Player = { ...p };
          if (a.name !== undefined) next.name = a.name.trim() || p.name;
          if (a.number !== undefined) next.number = a.number === null ? undefined : a.number;
          return next;
        }),
      }));

    case 'DELETE_PLAYER':
      return mapLeague(state, a.leagueId, l => ({
        ...l,
        players: l.players.filter(p => p.id !== a.playerId),
        teams: l.teams.map(t =>
          t.id === a.teamId ? { ...t, playerIds: t.playerIds.filter(id => id !== a.playerId) } : t
        ),
        // pull them out of any live lineups too
        games: l.games.map(g => ({
          ...g,
          homeOnCourt: g.homeOnCourt?.filter(id => id !== a.playerId),
          awayOnCourt: g.awayOnCourt?.filter(id => id !== a.playerId),
        })),
      }));

    case 'CREATE_GAME':
      return mapLeague(state, a.leagueId, l => {
        const game: Game = {
          id: a.id, leagueId: a.leagueId,
          homeTeamId: a.homeTeamId, awayTeamId: a.awayTeamId,
          status: 'live', scheduledAt: Date.now(), location: a.location,
          homeOnCourt: a.homeOnCourt ?? [], awayOnCourt: a.awayOnCourt ?? [],
        };
        return { ...l, games: [game, ...l.games] };
      });

    case 'SET_LINEUP':
      return mapLeague(state, a.leagueId, l => ({
        ...l,
        games: l.games.map(g =>
          g.id === a.gameId
            ? { ...g, [a.side === 'home' ? 'homeOnCourt' : 'awayOnCourt']: a.playerIds }
            : g
        ),
      }));

    case 'SET_LINEUPS':
      // Both starting fives in ONE update — avoids a realtime re-pull landing
      // between two separate SET_LINEUP writes and wiping the second side.
      return mapLeague(state, a.leagueId, l => ({
        ...l,
        games: l.games.map(g =>
          g.id === a.gameId ? { ...g, homeOnCourt: a.home, awayOnCourt: a.away } : g
        ),
      }));

    case 'SUBSTITUTE':
      return mapLeague(state, a.leagueId, l => ({
        ...l,
        games: l.games.map(g => {
          if (g.id !== a.gameId) return g;
          const key = a.side === 'home' ? 'homeOnCourt' : 'awayOnCourt';
          const current = (g[key] ?? []).slice();
          const idx = current.indexOf(a.outId);
          if (idx === -1) {
            if (current.length < 5 && !current.includes(a.inId)) current.push(a.inId);
          } else {
            current[idx] = a.inId;
          }
          return { ...g, [key]: current };
        }),
      }));

    case 'ADD_EVENT':
      return mapLeague(state, a.leagueId, l => {
        // Both `id` and `ts` come off the action (see stampActionIds). The
        // fallbacks cover a direct reducer call in a test; the app always
        // stamps them, so the two reducer runs per dispatch agree.
        const ev: GameEvent = {
          id: a.id ?? uid(), gameId: a.gameId, teamId: a.teamId,
          playerId: a.playerId, type: a.type, period: a.period, ts: a.ts ?? Date.now(),
          note: a.note,
        };
        const events = insertEvent(l.events, ev);
        const clearedRedo = l._redo ? { ...l._redo, [a.gameId]: [] } : undefined;

        // Foul-out: if this foul reaches the limit, pull the player off the court automatically.
        let games = l.games;
        if (a.type === 'pf' && a.playerId) {
          const limit = foulLimitOf(l);
          const fouls = events.filter(
            e => e.gameId === a.gameId && e.playerId === a.playerId && e.type === 'pf'
          ).length;
          if (fouls >= limit) {
            games = l.games.map(g => {
              if (g.id !== a.gameId) return g;
              return {
                ...g,
                homeOnCourt: g.homeOnCourt?.filter(id => id !== a.playerId),
                awayOnCourt: g.awayOnCourt?.filter(id => id !== a.playerId),
              };
            });
          }
        }
        return { ...l, events, games, _redo: clearedRedo };
      });

    case 'UNDO_EVENT':
      return mapLeague(state, a.leagueId, l => {
        const ofGame = l.events.filter(e => e.gameId === a.gameId);
        // Canonical (ts, id) order, matching the server's row order and
        // resolveUndoTarget's choice — all three must agree on "the last
        // event" or an undo removes a different row on each side.
        const last = lastEventOf(l.events, a.gameId);
        if (!last) return l;
        const redo = { ...(l._redo ?? {}) };
        redo[a.gameId] = [...(redo[a.gameId] ?? []), last]; // push onto the redo stack
        const events = l.events.filter(e => e.id !== last.id);

        // Undo has to reverse the whole effect of the event, not just the row.
        // ADD_EVENT auto-benches a player on their limit-reaching foul, so
        // undoing that foul must put them back — otherwise the scorekeeper is
        // left with a player on 4 fouls who is mysteriously off the floor and
        // has to be subbed in by hand mid-possession.
        //
        // Only when there is room. Undo pops the last EVENT, but substitutions
        // are not events, so someone may already have been sent on in the
        // fouled-out player's place; restoring blindly would put six on court.
        let games = l.games;
        if (last.type === 'pf' && last.playerId) {
          const pid = last.playerId;
          const limit = foulLimitOf(l);
          const before = ofGame.filter(e => e.playerId === pid && e.type === 'pf').length;
          const after = before - 1;
          // Did this foul cause the foul-out?
          if (before >= limit && after < limit) {
            games = l.games.map(g => {
              if (g.id !== a.gameId) return g;
              const side = g.homeTeamId === last.teamId ? 'homeOnCourt' as const : 'awayOnCourt' as const;
              const court = g[side] ?? [];
              if (court.includes(pid) || court.length >= 5) return g;
              return { ...g, [side]: [...court, pid] };
            });
          }
        }
        return { ...l, events, games, _redo: redo };
      });

    case 'REDO_EVENT':
      return mapLeague(state, a.leagueId, l => {
        const stack = l._redo?.[a.gameId] ?? [];
        if (stack.length === 0) return l;
        const ev = stack[stack.length - 1];
        const redo = { ...(l._redo ?? {}) };
        redo[a.gameId] = stack.slice(0, -1);
        // Reinsert where its `ts` puts it, not at the end. Appending made a
        // redone event look like the newest one locally while the server — which
        // orders by ts — put it back where it belonged, so a following Undo
        // removed different rows on the two sides.
        return { ...l, events: insertEvent(l.events, ev), _redo: redo };
      });

    case 'DELETE_EVENT':
      return mapLeague(state, a.leagueId, l => {
        const target = l.events.find(e => e.id === a.eventId);
        const events = l.events.filter(e => e.id !== a.eventId);
        if (!target) return { ...l, events };

        // Same reversal as UNDO_EVENT: deleting a foul-out-causing foul from
        // the play-by-play log must put the player back on court, or they're
        // left stranded on the bench with a foul count back under the limit
        // and no way back except a manual substitution. Unlike UNDO_EVENT
        // (which only ever pops the last event), DELETE_EVENT can remove any
        // event, so this checks the total foul count before/after removal
        // rather than assuming the deleted foul was the most recent one.
        let games = l.games;
        if (target.type === 'pf' && target.playerId) {
          const pid = target.playerId;
          const limit = foulLimitOf(l);
          const before = l.events.filter(e => e.gameId === target.gameId && e.playerId === pid && e.type === 'pf').length;
          const after = before - 1;
          if (before >= limit && after < limit) {
            games = l.games.map(g => {
              if (g.id !== target.gameId) return g;
              const side = g.homeTeamId === target.teamId ? 'homeOnCourt' as const : 'awayOnCourt' as const;
              const court = g[side] ?? [];
              if (court.includes(pid) || court.length >= 5) return g;
              return { ...g, [side]: [...court, pid] };
            });
          }
        }
        return { ...l, events, games };
      });

    case 'ROLLBACK_BUNDLE': {
      // A drop-in game or roster import is all-or-nothing: rec_setup_game and
      // bulk_import_roster are single transactions, so a failure means the
      // server has none of it. Leaving the local half behind is what produced
      // the reported state - a game that appears in the list, opens, and then
      // refuses every write because nothing it references exists server-side.
      // Cancelling the alert did not undo it either, because nothing ever did.
      if (a.removeLeague) {
        return { ...state, leagues: state.leagues.filter(l => l.id !== a.leagueId) };
      }
      const games = new Set(a.gameIds);
      const teams = new Set(a.teamIds);
      const players = new Set(a.playerIds);
      return mapLeague(state, a.leagueId, l => ({
        ...l,
        games: l.games.filter(g => !games.has(g.id)),
        events: l.events.filter(e => !games.has(e.gameId)),
        teams: l.teams
          .filter(t => !teams.has(t.id))
          .map(t => (t.playerIds.some(id => players.has(id))
            ? { ...t, playerIds: t.playerIds.filter(id => !players.has(id)) }
            : t)),
        players: l.players.filter(pl => !players.has(pl.id)),
      }));
    }

    case 'DELETE_GAME':
      return mapLeague(state, a.leagueId, l => ({
        ...l,
        games: l.games.filter(g => g.id !== a.gameId),
        events: l.events.filter(e => e.gameId !== a.gameId), // drop all stats logged for that game
      }));

    case 'CLEANUP_REC_GAMES':
      return mapLeague(state, a.leagueId, l => {
        const kill = new Set(a.gameIds);
        const survivingGames = l.games.filter(g => !kill.has(g.id));
        // Teams still referenced by a surviving game must be kept.
        const keepTeam = new Set<string>();
        for (const g of survivingGames) { keepTeam.add(g.homeTeamId); keepTeam.add(g.awayTeamId); }
        const teams = l.teams.filter(t => keepTeam.has(t.id));
        // Players belong to teams; keep only players on surviving teams.
        const keepPlayer = new Set<string>();
        for (const t of teams) for (const pid of t.playerIds) keepPlayer.add(pid);
        const players = l.players.filter(p => keepPlayer.has(p.id));
        return {
          ...l,
          games: survivingGames,
          events: l.events.filter(e => !kill.has(e.gameId)),
          teams,
          players,
        };
      });

    case 'BULK_IMPORT_ROSTER':
      return mapLeague(state, a.leagueId, l => {
        const newTeams: Team[] = a.teams.map((t, i) => ({
          id: t.id, name: t.name, color: teamColors[(l.teams.length + i) % teamColors.length],
          playerIds: t.players.map(p => p.id),
        }));
        const newPlayers: Player[] = a.teams.flatMap(t => t.players.map(p => ({ id: p.id, name: p.name, number: p.number })));
        return { ...l, teams: [...l.teams, ...newTeams], players: [...l.players, ...newPlayers] };
      });

    case 'SET_ATTENDANCE':
      return mapLeague(state, a.leagueId, l => ({
        ...l,
        games: l.games.map(g => g.id === a.gameId ? { ...g, attendance: a.playerIds } : g),
      }));

    case 'SET_GAME_STATUS':
      return mapLeague(state, a.leagueId, l => ({
        ...l,
        games: l.games.map(g =>
          g.id === a.gameId
            ? { ...g, status: a.status, finishedAt: a.status === 'final' ? Date.now() : g.finishedAt }
            : g
        ),
      }));

    case 'SET_PERIOD':
      return mapLeague(state, a.leagueId, l => ({
        ...l,
        games: l.games.map(g =>
          g.id === a.gameId ? { ...g, period: Math.max(1, a.period) } : g
        ),
      }));

    case 'DUPLICATE_LEAGUE': {
      // New season from an old one: teams (names/colors/logos/coaches), players,
      // and settings carry over with FRESH ids; games/events/stats start empty.
      const src = state.leagues.find(l => l.id === a.sourceLeagueId);
      if (!src || state.leagues.some(l => l.id === a.newLeagueId)) return state;
      const playerIdMap = new Map<string, string>();
      const players = src.players.map(pl => {
        const nid = uid();
        playerIdMap.set(pl.id, nid);
        // Breadcrumb: remember who this copy is. If the source is itself a
        // copy, point at the ultimate origin so chains stay one hop deep.
        return { ...pl, id: nid, originPlayerId: pl.originPlayerId ?? pl.id };
      });
      const teams = src.teams.map(t => ({
        ...t,
        id: uid(),
        playerIds: t.playerIds.map(pid => playerIdMap.get(pid)!).filter(Boolean),
      }));
      const copy: League = {
        id: a.newLeagueId,
        name: a.name.trim() || src.name,
        season: a.season.trim() || src.season,
        kind: src.kind ?? 'league',
        foulOutLimit: src.foulOutLimit,
        trackMisses: src.trackMisses,
        trackTurnovers: src.trackTurnovers,
        createdAt: Date.now(),
        teams, players, games: [], events: [],
      };
      return { ...state, leagues: [copy, ...state.leagues] };
    }

    case 'SET_LEAGUE_SETTINGS':
      return mapLeague(state, a.leagueId, l => ({
        ...l,
        ...(a.trackMisses !== undefined ? { trackMisses: a.trackMisses } : {}),
        ...(a.trackTurnovers !== undefined ? { trackTurnovers: a.trackTurnovers } : {}),
        ...(a.isClosed !== undefined ? { isClosed: a.isClosed } : {}),
        ...(a.isArchived !== undefined ? { isArchived: a.isArchived } : {}),
      }));

    case 'REC_SETUP_GAME': {
      // Ensure the rec league exists locally first (create if needed).
      let leagues = state.leagues;
      if (!leagues.some(l => l.id === a.leagueId) && a.ensureLeague) {
        const newLeague: League = {
          id: a.leagueId, name: a.ensureLeague.name, season: 'Drop-In',
          kind: 'recreational', isShared: a.ensureLeague.isShared || undefined,
          createdAt: Date.now(), teams: [], players: [], games: [], events: [],
        };
        leagues = [newLeague, ...leagues];
      }
      return {
        ...state,
        leagues: leagues.map(l => {
          if (l.id !== a.leagueId) return l;
          const newTeams: Team[] = [];
          const newPlayers: Player[] = [];
          a.teams.forEach((td, i) => {
            const playerIds: string[] = [];
            td.players.forEach(pd => {
              const p: Player = { id: pd.id, name: pd.name.trim() || 'Player', number: pd.number };
              newPlayers.push(p);
              playerIds.push(p.id);
            });
            newTeams.push({
              id: td.id,
              name: td.name.trim() || `Team ${i + 1}`,
              color: td.color ?? teamColors[(l.teams.length + i) % teamColors.length],
              playerIds,
            });
          });
          const game: Game = {
            id: a.gameId, leagueId: a.leagueId,
            homeTeamId: newTeams[0].id, awayTeamId: newTeams[1].id,
            createdBy: a.createdBy,
            status: 'live', scheduledAt: Date.now(), location: a.location,
            trackMisses: a.trackMisses, trackTurnovers: a.trackTurnovers,
            homeOnCourt: [], awayOnCourt: [], period: 1,
          };
          return {
            ...l,
            teams: [...l.teams, ...newTeams],
            players: [...l.players, ...newPlayers],
            games: [game, ...l.games],
          };
        }),
      };
    }

    default:
      return state;
  }
}

interface Ctx {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  ready: boolean;
  /** True when the app is connected to Supabase and syncing across devices. */
  synced: boolean;
  syncState: 'idle' | 'saving' | 'saved' | 'error';
  /**
   * Why the last write failed, in words, or null once one succeeds.
   *
   * `syncState: 'error'` says a write failed; it cannot say whether the server
   * refused it, the network never carried it, or a policy rejected the row - and
   * those need completely different answers. The live tracker shows this text,
   * because the person who needs it is standing courtside with no console.
   */
  lastSyncError: string | null;
  refresh: () => Promise<void>;
  /** Device-local favorites (leagues/teams pinned to the top of lists). */
  prefs: LocalPrefs;
  setHaptics: (on: boolean) => void;
  setNotifs: (on: boolean) => void;
  prefsReady: boolean;
  initialSyncDone: boolean;
  dismissOnboarding: () => void;
  toggleFavLeague: (leagueId: string) => void;
  toggleFavTeam: (teamId: string) => void;
}
const StoreCtx = createContext<Ctx | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, baseDispatch] = useReducer(reducer, initial);
  const [ready, setReady] = React.useState(false);
  const [prefs, setPrefs] = React.useState<LocalPrefs>({ favLeagueIds: [], favTeamIds: [], hapticsEnabled: true });
  const [prefsReady, setPrefsReady] = React.useState(false);
  const [initialSyncDone, setInitialSyncDone] = React.useState(!SYNC_ENABLED);
  const [syncState, setSyncState] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [lastSyncError, setLastSyncError] = React.useState<string | null>(null);
  const savedTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const first = useRef(true);
  const stateRef = useRef(state);
  const prefsRef = useRef(prefs);
  const authSubRef = useRef<{ unsubscribe: () => void } | null>(null);
  stateRef.current = state;
  prefsRef.current = prefs;

  /* ------------------------------------------------------------------ pulls --
   * ONE owner for every server pull.
   *
   * There used to be five, none of them aware of the others: the boot pull, its
   * background retry loop, the post-auth re-pull, the realtime refetch, and
   * pull-to-refresh. Each took its own snapshot tick, read the whole server
   * state, and hydrated whatever came back, whenever it came back. Two of them
   * overlapping is all it takes to lose a committed stat, because the pending
   * ledger has legitimately retired the write by the time the older reply lands:
   *
   *     auth re-pull starts, reads 0 rows, reply slow in transit
   *     tap 3PT                -> 3
   *     realtime refetch reads 1 row, lands first, ledger entry retires
   *     auth re-pull lands     -> 0     <- reverted, with no user action
   *
   * The realtime handler's own `refetching` flag guarded it only against
   * itself, and it DROPPED coalesced echoes rather than queueing one, so the
   * device could also be left holding a snapshot older than the change that
   * asked for it - removing the accidental self-healing that had been masking
   * how often this happened.
   *
   * So: at most one read on the wire, a single queued follow-up when something
   * asks while one is running, and `acceptSnapshot` as the backstop that refuses
   * an out-of-order reply outright.
   */
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);
  const pullGate = useRef<{ inFlight: Promise<PullResult> | null; trailing: boolean }>({ inFlight: null, trailing: false });

  /** Hydrate one snapshot, or refuse it and say why. */
  const applySnapshot = useCallback((at: number, remote: Partial<AppState> | null, source: string): boolean => {
    const leagues = remote?.leagues;
    if (!leagues) return false;
    // An empty league list is not evidence that this account owns nothing: an
    // RLS read taken while the access token is mid-refresh comes back as an
    // empty array rather than an error. The post-auth re-pull hydrated it
    // unconditionally, which wiped every league on the device until the next
    // successful pull. The boot pull always checked; this now does too.
    if (leagues.length === 0 && stateRef.current.leagues.length > 0) {
      warn(`[sync] refused an empty snapshot (${source}); keeping ${stateRef.current.leagues.length} local league(s)`);
      return false;
    }
    // Ordering, not order of arrival.
    if (!acceptSnapshot(at)) {
      trace('SNAPSHOT', `REJECTED at=${at} applied=${appliedSnapshotAt()} reason=stale-snapshot source=${source}`);
      return false;
    }
    trace('SNAPSHOT', `accepted at=${at} leagues=${leagues.length} source=${source}`);
    baseDispatch({ t: 'HYDRATE', state: { leagues }, snapshotAt: at });
    return true;
  }, []);

  const pullState = useCallback((source: string): Promise<PullResult> => {
    const sb = SYNC_ENABLED ? getSupabase() : null;
    if (!sb) return Promise.resolve({ applied: false, hadData: false });
    const gate = pullGate.current;
    if (gate.inFlight) {
      // Queue exactly one follow-up and hand back the pull already running, so
      // pull-to-refresh still resolves when the data it is waiting for arrives.
      gate.trailing = true;
      trace('PULL', `queued source=${source}`);
      return gate.inFlight;
    }
    const run = (async (): Promise<PullResult> => {
      let applied = false;
      let hadData = false;
      try {
        do {
          gate.trailing = false;
          // Tick BEFORE the fetch: rows read after this point may predate any
          // local write confirmed after it. See sync/pendingEvents.ts.
          const at = beginSnapshot();
          const remote = await fetchAllState(sb);
          if (!aliveRef.current) break;
          hadData = hadData || !!remote?.leagues?.length;
          applied = applySnapshot(at, remote, source) || applied;
        } while (gate.trailing);
      } catch (e) {
        // Never silent: a failed pull is how a device ends up looking empty for
        // no visible reason.
        warn(`[sync] pull failed (${source}):`, (e as Error)?.message ?? String(e));
      } finally {
        gate.inFlight = null;
      }
      return { applied, hadData };
    })();
    gate.inFlight = run;
    return run;
  }, [applySnapshot]);

  // Hydrate from local storage first (fast, offline-friendly), then if synced,
  // wait until Supabase auth is ready (anonymous sign-in finishes), then pull
  // the authoritative server state. Without waiting, the initial pull would
  // hit row-level security as an anonymous-unauthenticated caller and silently
  // return an empty array — making the device look like it has no data.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await loadState();
      if (!cancelled && saved) baseDispatch({ t: 'HYDRATE', state: saved });
      const savedPrefs = await loadPrefs();
      if (!cancelled && savedPrefs) {
        const hz = savedPrefs.hapticsEnabled ?? true;
        setPrefs({ favLeagueIds: savedPrefs.favLeagueIds ?? [], favTeamIds: savedPrefs.favTeamIds ?? [], hapticsEnabled: hz, seenOnboarding: savedPrefs.seenOnboarding, notifsEnabled: savedPrefs.notifsEnabled });
        setHapticsEnabled(hz);
      }
      if (!cancelled) setPrefsReady(true);

      if (SYNC_ENABLED) {
        const sb = getSupabase();
        if (sb) {
          // Wait for a session (anonymous sign-in is kicked off by
          // AdminProvider), because an RLS read with no token returns an empty
          // array rather than an error and the device just looks blank.
          //
          // This waits on the auth EVENT, not on a poll. It used to call
          // getSession() every 200ms for up to eight seconds — up to forty
          // calls, each of which supabase-js queues behind its own
          // initialisation (which refreshes an expired token over the network),
          // all racing AdminProvider's boot sequence for the same client. On a
          // slow or unreachable connection that turned one stalled request into
          // a pile-up of timeouts, which is what the reported launch logs show.
          // One read, then listen.
          await waitForSession(sb, 8000);

          // Pull the authoritative server state. CRUCIAL: if this first attempt
          // yields nothing (no session yet, or a slow/failed network call), we
          // DON'T give up — we retry quietly in the background with backoff, so
          // a slow-starting guest session recovers on its own without needing
          // the user to sign in or relaunch. This is the iPad "empty on first
          // open, appeared after sign-in" fix: the sign-in wasn't required,
          // the retry would have filled it in regardless.
          // `hadData`, not "the pull worked": an empty result may only mean the
          // session was not ready, so it must keep retrying. Applying the
          // snapshot is now pullState's business, not this loop's.
          const gotData = (await pullState('boot')).hadData;
          if (gotData && !cancelled) setInitialSyncDone(true);
          if (!gotData && !cancelled) {
            // Background retry: 1s, 2s, 4s, 8s, then every 15s up to ~1 min.
            // Stops as soon as a pull succeeds or the screen unmounts.
            (async () => {
              const delays = [1000, 2000, 4000, 8000, 15000, 15000, 15000];
              for (const d of delays) {
                if (cancelled) return;
                await new Promise(r => setTimeout(r, d));
                if (cancelled) return;
                if ((await pullState('boot-retry')).hadData) { if (!cancelled) setInitialSyncDone(true); return; }
              }
              // Retries exhausted: stop showing a loading state and let the
              // empty view (with pull-to-refresh) take over.
              if (!cancelled) setInitialSyncDone(true);
            })();
          }

          // If auth state changes later (e.g. the very first sign-in completes
          // after the initial wait), re-pull so the device picks up data.
          //
          // Only for the events that actually change WHICH DATA this device can
          // see. This used to fire on every auth event, and with
          // `autoRefreshToken: true` that includes TOKEN_REFRESHED - a periodic
          // background event that says nothing whatsoever about the data, and
          // whose re-pull raced the realtime refetch for the live game the
          // scorekeeper was in the middle of. INITIAL_SESSION is skipped too:
          // supabase-js replays it to every new subscriber, and the boot pull
          // above has already covered that moment.
          const { data: sub } = sb.auth.onAuthStateChange((event, s) => {
            if (!s || cancelled) return;
            if (event !== 'SIGNED_IN' && event !== 'USER_UPDATED') return;
            void pullState(`auth:${event}`);
          });
          // Stash so cleanup works
          authSubRef.current = sub.subscription;
        }
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
      authSubRef.current?.unsubscribe();
    };
    // `pullState` is stable for the life of the provider (its only dependency,
    // applySnapshot, has an empty dependency list), so this still runs exactly
    // once - it is listed because it is used, not because it changes.
  }, [pullState]);

  // Realtime subscription: when ANY row changes (from another device), re-pull
  // the full state. Cheap on a free tier with our data volume; the realtime
  // channel just signals "something changed", and we treat the server as truth.
  useEffect(() => {
    if (!SYNC_ENABLED || !ready) return;
    const sb = getSupabase();
    if (!sb) return;
    // Coalescing, queueing and ordering all live in pullState now, so a burst
    // of echoes costs one read and a single trailing one - and can no longer
    // overlap the boot retry, a post-auth re-pull, or pull-to-refresh.
    const unsubscribe = subscribeRealtime(sb, () => { void pullState('realtime'); });
    return unsubscribe;
  }, [ready, pullState]);

  // Manual refresh for pull-to-refresh: re-pull the full server state now.
  const refresh = useCallback(async () => {
    await pullState('manual-refresh');
  }, [pullState]);

  // Wrapped dispatch: apply the action locally, then push the resulting state
  // to Supabase. We compute the post-dispatch state inline via the reducer so
  // pushAction sees the exact rows we want to mirror — no React render gap.
  const dispatch = useCallback<React.Dispatch<Action>>((incoming) => {
    // HYDRATE is server→local; don't echo it back.
    if (incoming.t === 'HYDRATE') { baseDispatch(incoming); return; }

    // Name the exact event row this action is about, from the PRE-dispatch
    // state, before anything else looks at it. The reducer, the server push and
    // the pending ledger then all agree on which row moved.
    const action: Action = stampActionIds(stateRef.current, incoming);

    const prev = stateRef.current;
    const next = reducer(prev, action);
    stateRef.current = next;
    baseDispatch(action);

    // Record this write in the pending ledger BEFORE the push starts, so a
    // snapshot that lands mid-flight is reconciled against it rather than
    // silently overwriting it. Both halves of the state a live game can move -
    // the events and the game row - go in, and the ledger works out which by
    // diffing prev against next. See sync/pendingEvents.ts.
    const pushTokens = recordPending(action, prev, next);
    trace('ACTION', `t=${action.t} game=${'gameId' in action ? action.gameId : '-'} tokens=${pushTokens.join(',') || 'none'}`);

    // Protect freshly-created bundles (rows that exist locally but haven't
    // finished their server round trip) from being deleted by a mid-write
    // refetch. See guardBundle / HYDRATE.
    if (action.t === 'REC_SETUP_GAME') {
      guardBundle({
        leagueId: action.leagueId,
        gameIds: [action.gameId],
        teamIds: action.teams.map(t => t.id),
        playerIds: action.teams.flatMap(t => t.players.map(p => p.id)),
      });
    }
    if (action.t === 'BULK_IMPORT_ROSTER') {
      guardBundle({
        leagueId: action.leagueId,
        gameIds: [],
        teamIds: action.teams.map(t => t.id),
        playerIds: action.teams.flatMap(t => t.players.map(p => p.id)),
      });
    }

    // Final-score nudge for favorited teams (local notification, opt-in).
    if (action.t === 'SET_GAME_STATUS' && action.status === 'final' && prefsRef.current.notifsEnabled) {
      const lg = next.leagues.find(l => l.id === action.leagueId);
      const g = lg?.games.find(x => x.id === action.gameId);
      if (lg && g) {
        const favT = new Set(prefsRef.current.favTeamIds);
        if (favT.has(g.homeTeamId) || favT.has(g.awayTeamId)) {
          const home = lg.teams.find(t => t.id === g.homeTeamId);
          const away = lg.teams.find(t => t.id === g.awayTeamId);
          import('../lib/stats').then(({ gameScore }) => {
            const sc = gameScore(lg, g);
            import('../lib/notify').then(({ notifyNow }) => {
              void notifyNow('Final score', `${home?.name} ${sc.home} — ${sc.away} ${away?.name}`);
            });
          }).catch(() => {});
        }
      }
    }

    if (SYNC_ENABLED) {
      const sb = getSupabase();
      if (sb) {
        // Surface a lightweight save indicator: saving → saved (2s) → idle.
        // Most errors are swallowed inside pushAction; the writes where a silent
        // failure loses data the user can see on screen rethrow, and land in the
        // .catch below as 'error'.
        //
        // enqueuePush serializes these so they reach the server in dispatch
        // order. Firing them independently let a DELETE overtake the INSERT it
        // was undoing, which resurrected the stat on the next pull — see
        // sync/pushQueue.ts.
        setSyncState('saving');
        void enqueuePush(() => pushAction(sb, action, next))
          .then(() => {
            // The server has it. The ledger entry stays until a snapshot read
            // after this moment confirms it — an older one is still in flight.
            confirmPending(pushTokens);
            trace('PERSIST', `ok t=${action.t} tokens=${pushTokens.join(',') || 'none'}`);
            setLastSyncError(null);
            setSyncState('saved');
            if (savedTimer.current) clearTimeout(savedTimer.current);
            savedTimer.current = setTimeout(() => setSyncState('idle'), 2000);
          })
          .catch((e) => {
            // Pin the entry: the scorekeeper's stat stays on the board and the
            // badge stays red, rather than the board quietly reverting later.
            failPending(pushTokens);
            trace('PERSIST', `FAILED t=${action.t} tokens=${pushTokens.join(',') || 'none'}`);
            // Keep the reason, not just the fact. `${action.t}` is included
            // because "which write failed" is half the diagnosis: an ADD_EVENT
            // that the server refuses and a game-row upsert that the server
            // refuses look identical from a red badge, and only one of them
            // loses the stat.
            setLastSyncError(`${action.t}: ${describeSyncFailure(e)}`);
            setSyncState('error');

            // Setting up a drop-in game or importing a roster is all-or-nothing
            // on the server: both are single transactions, so a failure means
            // NONE of it was written. Keeping the local half is therefore not
            // "offline-first", it is a lie - the reported symptom was a game
            // that showed up in the list, opened, and then refused every write,
            // with Cancel on the alert changing nothing because nothing ever
            // undid it. Roll the local rows back so the app's state matches the
            // server's, and say plainly that nothing was saved.
            //
            // If the write did land and only the reply was lost, the next pull
            // brings it back - the wrong guess in this direction is recoverable
            // and the wrong guess in the other is not.
            if (action.t === 'REC_SETUP_GAME' || action.t === 'BULK_IMPORT_ROSTER') {
              const isGame = action.t === 'REC_SETUP_GAME';
              const rollback: Action = {
                t: 'ROLLBACK_BUNDLE',
                leagueId: action.leagueId,
                gameIds: isGame ? [action.gameId] : [],
                teamIds: action.teams.map(t => t.id),
                playerIds: action.teams.flatMap(t => t.players.map(p => p.id)),
                // Only when THIS action created the league. Anything else would
                // take an existing space (and its history) down with it.
                removeLeague: isGame && !!action.ensureLeague,
              };
              // Keep the ref in step with the reducer, as the main dispatch path
              // does: a write issued before the next render must not be computed
              // against a state that still contains the rows just rolled back.
              stateRef.current = reducer(stateRef.current, rollback);
              baseDispatch(rollback);
              Alert.alert(
                isGame ? "Drop-in game not started" : "Roster not imported",
                `${isGame
                  ? 'Nothing was saved, so the game has been removed rather than left half-created.'
                  : 'Nothing was imported, so the partial roster has been removed.'}\n\n${describeSyncFailure(e)}`,
              );
            }
          });
      }
    }
  }, []);

  // Favorites: pure device-local preference. Toggle + persist; never synced.
  const toggleFav = useCallback((key: 'favLeagueIds' | 'favTeamIds', id: string) => {
    setPrefs(prev => {
      const cur = prev[key] ?? [];
      const list = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
      const next = { ...prev, [key]: list };
      void savePrefs(next);
      return next;
    });
  }, []);
  const dismissOnboarding = useCallback(() => {
    setPrefs(prev => { const next = { ...prev, seenOnboarding: true }; void savePrefs(next); return next; });
  }, []);
  const setNotifs = useCallback((on: boolean) => {
    setPrefs(prev => { const next = { ...prev, notifsEnabled: on }; void savePrefs(next); return next; });
    if (on) void ensureNotifPermission();
  }, []);
  const setHaptics = useCallback((on: boolean) => {
    setHapticsEnabled(on);
    setPrefs(prev => { const next = { ...prev, hapticsEnabled: on }; void savePrefs(next); return next; });
  }, []);
  const toggleFavLeague = useCallback((leagueId: string) => toggleFav('favLeagueIds', leagueId), [toggleFav]);
  const toggleFavTeam = useCallback((teamId: string) => toggleFav('favTeamIds', teamId), [toggleFav]);

  // Autosave on every change — persist every mutation so a live game never dies.
  useEffect(() => {
    if (!ready) return;
    if (first.current) { first.current = false; }
    saveState(state);
  }, [state, ready]);

  return <StoreCtx.Provider value={{ state, dispatch, ready, synced: SYNC_ENABLED, refresh, prefs, toggleFavLeague, toggleFavTeam, setHaptics, setNotifs, syncState, lastSyncError, prefsReady, initialSyncDone, dismissOnboarding }}>{children}</StoreCtx.Provider>;
}

export function useStore(): Ctx {
  const c = useContext(StoreCtx);
  if (!c) throw new Error('useStore must be used within StoreProvider');
  return c;
}

// convenience selectors
export function useLeague(leagueId?: string): League | undefined {
  const { state } = useStore();
  return state.leagues.find(l => l.id === leagueId);
}
