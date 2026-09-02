// `AppState` is this app's own root state type (../types). React Native exports
// a module with the same name for foreground/background, so it is aliased here
// rather than renaming a type used across thirty files.
import { Alert, AppState as RNAppState } from 'react-native';
import React, { createContext, useContext, useEffect, useReducer, useRef, useCallback } from 'react';
import { AppState, League, Team, Player, Game, GameEvent, EventType, LocalPrefs, LegacyPersistedSettings } from '../types';
import { setHapticsEnabled } from '../lib/haptics';
import { ensureNotifPermission } from '../lib/notify';
import { uid } from '../lib/format';
import { teamColors, DEFAULT_FOUL_OUT } from '../theme';
import { loadState, saveState, loadPrefs, savePrefs, loadOutbox, saveOutbox } from './storage';
import { getSupabase, SYNC_ENABLED } from '../sync/supabase';
import { LiveElsewhere, PullScope, StateSnapshot, fetchAllState, fetchLeagueDetail, fetchLiveGames, fetchMemberships, pingServer, pushAction, pushPendingEntry, subscribeRealtime } from '../sync/sync';
import { enqueuePush, __resetPushQueue } from '../sync/pushQueue';
import {
  acceptSnapshot, appliedSnapshotAt, beginPush, beginSnapshot, confirmPending,
  drainableEntries, failPending, insertEvent, lastEventOf, outboxSnapshot,
  pruneOutbox, recordPending, reconcileLeagueEvents, reconcileLeagueGames, restoreOutbox,
  sortEvents, unsyncedCount, __resetPending,
} from '../sync/pendingEvents';
import {
  NetStatus, isKnownOffline, netStatus, noteReachable, noteUnreachable,
  probeDelay, subscribeNet, __resetNet,
} from '../sync/connectivity';
import { SyncSummary, WriteState, describeSync } from '../sync/syncStatus';
import { isDevBuild, trace, warn } from '../lib/log';
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

/**
 * A sync failure, said to the PERSON.
 *
 * Never the server's own words. This used to fall through to `return msg`, so an
 * unrecognised failure put raw PostgREST text in front of a scorekeeper - things
 * like `new row violates row-level security policy for table "events"`. That
 * names internal tables, tells nobody what to do, and is alarming courtside. The
 * fallback is now a sentence a human can act on, and the server's wording goes
 * where it belongs: the log, and `technicalSyncDetail` in dev builds.
 *
 * Every branch here has to say what to DO, not just what went wrong.
 */
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
  if (/row-level security|permission denied|not authori[sz]ed|jwt|401|403/i.test(msg)) {
    return 'The server would not accept the change. Your scoring rights may have changed — '
      + 'try signing out and back in, or ask a league owner to add you again.';
  }
  return 'The server would not accept the change. Nothing has been lost on this device.';
}

/**
 * The same failure for a DEVELOPER: the server's own words, dev builds only.
 *
 * null in a release build, and every caller must render fine without it.
 */
function technicalSyncDetail(e: unknown): string | null {
  if (!isDevBuild()) return null;
  const msg = (e as Error)?.message ?? String(e ?? '');
  return msg || null;
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

/**
 * What a manual refresh did, for the screen that asked for it.
 *
 *   'refreshed'  the server answered and local state is current
 *   'offline'    the server was not reached - either the request failed at the
 *                transport, or it was never sent because we already knew
 *   'local-only' this build has no server; there is nothing to refresh
 */
export type RefreshOutcome = 'refreshed' | 'offline' | 'local-only';

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
      /** Which leagues this snapshot's heavy tables cover; null (or absent) for
       *  "all of them". A league outside the scope keeps the children this
       *  device already has: the snapshot was never asked about them, so its
       *  silence says nothing. See StateSnapshot in sync/sync.ts. */
      covered?: readonly string[] | null;
    }
  /**
   * One league's heavy tables, fetched on demand because someone opened it.
   *
   * Separate from HYDRATE because HYDRATE REPLACES the league list with the
   * snapshot's, which is right for a full pull and catastrophic for a
   * single-league read - it would delete every other league on the device. This
   * merges into the league it names and leaves the rest untouched.
   */
  | {
      t: 'HYDRATE_LEAGUE';
      leagueId: string;
      detail: { teams: Team[]; players: Player[]; games: Game[]; events: GameEvent[] };
      /** Tick from `beginSnapshot()`, taken BEFORE the fetch, as HYDRATE's is. */
      snapshotAt: number;
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
  __resetNet();
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

      // Which leagues this snapshot is allowed to speak for. `null` is every
      // league, which is what an unscoped pull sends and what every caller sent
      // before scoping existed - so this is a no-op until something narrows it.
      const covered = a.covered ?? null;
      const coveredSet = covered === null ? null : new Set(covered);
      const speaksFor = (id: string) => coveredSet === null || coveredSet.has(id);

      const leagues = a.state.leagues.map(l => {
        // OUT OF SCOPE: take the catalogue fields, keep the children. The
        // snapshot carried this league's name and season but was never asked
        // for its games, so replacing them with the empty arrays it happens to
        // have would delete them - and the autosave would make that permanent.
        if (a.snapshotAt !== undefined && !speaksFor(l.id)) {
          const local = localLeagues.get(l.id);
          const scalars = l.trackMisses === undefined ? { ...l, trackMisses: legacyTrackMisses } : l;
          return {
            ...scalars,
            teams: local?.teams ?? [],
            players: local?.players ?? [],
            games: local?.games ?? [],
            events: local?.events ?? [],
            _redo: local?._redo,
            // Unchanged by definition: this snapshot read none of it, so it can
            // neither prove the detail is here nor that it is not. Explicit
            // `false` rather than undefined: undefined means "saved by a build
            // that predates this field", which the local-storage hydrate below
            // reads as loaded, and a league that arrived in the catalogue and
            // was never fetched must not become loaded by being saved.
            detailLoaded: local?.detailLoaded ?? false,
          } as League;
        }
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
        let out: League = {
          ...migrated, games, _redo: localLeagues.get(l.id)?._redo,
          // A server snapshot that speaks for this league has just read all four
          // of its heavy tables, so the detail is here.
          //
          // A hydrate from local storage proves nothing either way and carries
          // the saved value through - except that `undefined` there means the
          // state was written by a build with no such field, when every pull
          // was global and every saved league therefore WAS complete. Reading
          // that as "not loaded" would put a spinner over every league on the
          // first launch after upgrading, and in a local-only build (no server
          // to fetch from) it would never clear.
          detailLoaded: a.snapshotAt === undefined ? (l.detailLoaded ?? true) : true,
        };

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

    case 'HYDRATE_LEAGUE': {
      const local = state.leagues.find(l => l.id === a.leagueId);
      // Nothing to merge into. The catalogue is the only thing that introduces
      // a league, so a detail read for one this device has never heard of is a
      // race with a delete, not a new league.
      if (!local) return state;
      return {
        ...state,
        leagues: state.leagues.map(l => l.id !== a.leagueId ? l : {
          ...l,
          teams: a.detail.teams,
          players: a.detail.players,
          // The same reconciliation a full pull applies, for the same reason: a
          // lineup or a basket logged while this read was in flight must not be
          // reverted by it. See sync/pendingEvents.ts.
          games: reconcileLeagueGames(l.id, a.detail.games, a.snapshotAt, l.games),
          events: reconcileLeagueEvents(l.id, a.detail.events, a.snapshotAt),
          _redo: l._redo,
          detailLoaded: true,
        }),
      };
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
        // Created here, so its (empty) detail is genuinely in hand. Without
        // this a brand-new league would look unfetched and show a spinner over
        // a league the person is standing in.
        detailLoaded: true,
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
  /**
   * Fetch one league's teams, players, games and events, for a league the
   * catalogue knows about but this device has not read.
   *
   * Idempotent and de-duplicated: a screen may call it on every render without
   * issuing a second request, and two screens asking at once share one. Returns
   * whether the detail is now in hand.
   */
  loadLeagueDetail: (leagueId: string) => Promise<boolean>;
  /** League ids with a detail fetch in flight, for a loading state. */
  leaguesLoading: readonly string[];
  /**
   * Record that a league was opened, so later pulls keep it up to date.
   *
   * Cheap and idempotent; safe to call from a screen effect.
   */
  noteLeagueOpened: (leagueId: string) => void;
  /**
   * Live games in leagues this device has NOT loaded, for the Home banner.
   *
   * The one cross-league view that survives scoping. Transient: never
   * persisted, and no screen but the banner should read it - it is a projection
   * of a few rows, not league data.
   */
  liveElsewhere: readonly LiveElsewhere[];
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
  /** The same failure in the server's own words, for a developer. null in a
   *  release build, so nothing user-facing may depend on it. */
  lastSyncErrorDetail: string | null;
  /**
   * Whether the SERVER is reachable, as last observed. Not whether the build
   * has sync configured (`synced`), and not whether a radio is on: a device on
   * a captive-portal wifi is 'offline' here, correctly, because a stat logged
   * on it is exactly as unsent as one logged in aeroplane mode.
   */
  net: NetStatus;
  /** Local writes the server has not confirmed. Survives an app restart. */
  pendingWrites: number;
  /**
   * The single answer to "is my work saved?", for every screen that shows one.
   * Derived in sync/syncStatus.ts so the wording and the precedence between
   * these inputs live in one tested place rather than in three components.
   */
  sync: SyncSummary;
  /**
   * Re-pull the server state now.
   *
   * Returns what happened, because pull-to-refresh has to say something when
   * nothing can. 'offline' means the request was not attempted (the server is
   * known unreachable) or it failed at the transport; the caller shows the
   * toast. Callers that only want the side effect can still ignore this.
   */
  refresh: () => Promise<RefreshOutcome>;
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
  const [syncState, setSyncState] = React.useState<WriteState>('idle');
  const [lastSyncError, setLastSyncError] = React.useState<string | null>(null);
  const [lastSyncErrorDetail, setLastSyncErrorDetail] = React.useState<string | null>(null);
  // Reachability and outbox depth are module state (they have to be: the push
  // path is not a component). These mirror them into React so a screen
  // re-renders when either moves.
  const [net, setNet] = React.useState<NetStatus>(netStatus);
  const [pendingWrites, setPendingWrites] = React.useState(0);
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

  /* ---------------------------------------------------------------- outbox --
   * Write the ledger to disk and republish its depth.
   *
   * Called at every point the ledger moves: a local write recorded, a push
   * settled either way, a drain attempt finished. That is more often than
   * strictly necessary - the state autosave beside it already runs per dispatch
   * - and it is the right trade: the whole failure this closes is a queue that
   * existed only in memory, so "persisted a moment too often" is the side to
   * err on.
   *
   * `saveOutbox` is fire-and-forget and swallows its own failures, exactly as
   * `saveState` does. Nothing on the tap path may await storage.
   */
  const persistOutbox = useCallback(() => {
    void saveOutbox(outboxSnapshot());
    setPendingWrites(unsyncedCount());
  }, []);

  // Reachability is observed on the push and pull paths (see below), which are
  // module-level; this is the bridge into React.
  useEffect(() => subscribeNet(setNet), []);

  /**
   * Leagues the most recently applied snapshot spoke for, or null for "all of
   * them". Read by the drain, which must not mistake an unloaded league for a
   * league whose games were deleted. See pruneOutbox.
   */
  const coveredRef = useRef<readonly string[] | null>(null);

  /** Hydrate one snapshot, or refuse it and say why. */
  const applySnapshot = useCallback((at: number, remote: StateSnapshot | null, source: string): boolean => {
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
    // The scope travels WITH the snapshot rather than being read from provider
    // state, so a snapshot that was in flight while the scope changed is still
    // applied against the scope it was actually taken with.
    const covered = remote?.covered ?? null;
    coveredRef.current = covered;
    baseDispatch({ t: 'HYDRATE', state: { leagues }, snapshotAt: at, covered });
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
          // Alongside the snapshot, not part of it: the banner spans every
          // league and the pull no longer does. Started BEFORE the tick below
          // and never awaited with it, for two reasons - a failure here must not
          // cost the snapshot, and the tick must stay adjacent to the read it
          // dates (see the static assertion). A briefly stale banner is not a
          // correctness problem; a mis-dated snapshot is.
          void (async () => {
            try {
              const live = await fetchLiveGames(sb);
              if (live !== null && aliveRef.current) setLiveElsewhere(live);
            } catch {
              // Offline, or the host refused. The previous list stands; the
              // pull's own reachability handling is the authority on status.
            }
          })();
          const at = beginSnapshot();
          const remote = await fetchAllState(sb, scopeRef.current);
          // The read came back. Whether it carried rows is a different question
          // (row-level security answers plenty of reads with none), and not the
          // one reachability asks.
          noteReachable();
          if (!aliveRef.current) break;
          hadData = hadData || !!remote?.leagues?.length;
          applied = applySnapshot(at, remote, source) || applied;
        } while (gate.trailing);
      } catch (e) {
        // Never silent: a failed pull is how a device ends up looking empty for
        // no visible reason. It is also the cheapest connectivity evidence the
        // app gets - a five-table read that never left the device is exactly
        // what "offline" means here.
        noteUnreachable(e);
        warn(`[sync] pull failed (${source}):`, (e as Error)?.message ?? String(e));
      } finally {
        gate.inFlight = null;
      }
      return { applied, hadData };
    })();
    gate.inFlight = run;
    return run;
  }, [applySnapshot]);

  /**
   * WHICH LEAGUES A PULL READS IN FULL.
   *
   * The catalogue is always read whole - browsing every league is the product.
   * The four heavy tables are read only for leagues this device actually uses,
   * because the alternative is every device downloading every event in the
   * database on every pull (the ceiling that made N-39's truncation possible in
   * the first place).
   *
   * Three sources, and the reason for each:
   *   memberships   leagues this account runs. Their games are the ones being
   *                 scored, so they must be present and offline-capable.
   *   favourites    a fan's own leagues. Local prefs, so they cost nothing to
   *                 know and are available before the first request.
   *   recents       leagues opened lately, bounded. Without these, going back
   *                 to a league you were just in would re-fetch it.
   *
   * Held in a ref as well as prefs because `pullState` is a stable callback and
   * must not close over a stale scope.
   */
  const scopeRef = useRef<PullScope>(null);
  const [liveElsewhere, setLiveElsewhere] = React.useState<readonly LiveElsewhere[]>([]);
  const membersRef = useRef<readonly string[] | null>(null);
  const computeScope = useCallback((p: LocalPrefs, members: readonly string[] | null): PullScope => {
    const ids = new Set<string>([
      ...(members ?? p.memberLeagueIds ?? []),
      ...p.favLeagueIds,
      ...(p.recentLeagueIds ?? []),
    ]);
    return [...ids];
  }, []);

  /**
   * One league's detail, on demand.
   *
   * The in-flight map is what makes this callable from a render path: a screen
   * that asks on every render must not open a request on every render, and two
   * screens mounting together must share one. Failures are NOT cached - a
   * league that failed to load has to be retryable, or a single flaky moment
   * would leave it permanently blank.
   */
  const detailInFlight = useRef(new Map<string, Promise<boolean>>());
  const [leaguesLoading, setLeaguesLoading] = React.useState<readonly string[]>([]);
  const loadLeagueDetail = useCallback((leagueId: string): Promise<boolean> => {
    const running = detailInFlight.current.get(leagueId);
    if (running) return running;

    const sb = SYNC_ENABLED ? getSupabase() : null;
    // Local-only build: whatever is on the device IS the whole truth, so there
    // is nothing to fetch and nothing to wait for.
    if (!sb) return Promise.resolve(true);

    const run = (async (): Promise<boolean> => {
      // Ticked BEFORE the read, exactly as pullState does it: that is what makes
      // "this snapshot predates that confirmation" decidable, and it is what
      // stops this read reverting a basket tapped while it was in flight.
      const at = beginSnapshot();
      try {
        const detail = await fetchLeagueDetail(sb, leagueId);
        noteReachable();
        if (!aliveRef.current || !detail) return false;
        baseDispatch({ t: 'HYDRATE_LEAGUE', leagueId, detail, snapshotAt: at });
        return true;
      } catch (e) {
        // A transport failure here means offline, the same as it does on a pull.
        noteUnreachable(e);
        warn(`[sync] league detail failed (${leagueId}):`, (e as Error)?.message ?? String(e));
        return false;
      } finally {
        detailInFlight.current.delete(leagueId);
        setLeaguesLoading(prev => prev.filter(id => id !== leagueId));
      }
    })();

    detailInFlight.current.set(leagueId, run);
    setLeaguesLoading(prev => (prev.includes(leagueId) ? prev : [...prev, leagueId]));
    return run;
  }, []);

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

      // BEFORE any server pull, and that ordering is the fix.
      //
      // Restored entries are unconfirmed, and an unconfirmed entry is one no
      // snapshot may overwrite (see sync/pendingEvents.ts). Without them the
      // boot pull hydrates the server's rows through an EMPTY ledger, which
      // hands back the server's version verbatim - so stats logged offline in
      // the previous session were deleted from state, and the autosave that
      // runs on the very next render wrote that back over the only durable copy
      // of them. That is the reported "scores are missing after reopening the
      // app", and it happened before anything the person could see or do.
      //
      // Gated for the same reason the recording side is: nothing in a build
      // without credentials can confirm, retire or send these. Restoring them
      // would only pin writes forever and report a queue depth nobody can act
      // on. The key on disk is left untouched, so a build that does have a
      // server still picks them up.
      if (!cancelled && SYNC_ENABLED) {
        const restored = restoreOutbox(await loadOutbox());
        if (restored > 0) trace('OUTBOX', `restored ${restored} unsent write(s) from disk`);
        setPendingWrites(unsyncedCount());
      }

      const savedPrefs = await loadPrefs();
      if (!cancelled && savedPrefs) {
        const hz = savedPrefs.hapticsEnabled ?? true;
        const restored: LocalPrefs = {
          favLeagueIds: savedPrefs.favLeagueIds ?? [],
          favTeamIds: savedPrefs.favTeamIds ?? [],
          hapticsEnabled: hz,
          seenOnboarding: savedPrefs.seenOnboarding,
          notifsEnabled: savedPrefs.notifsEnabled,
          recentLeagueIds: savedPrefs.recentLeagueIds ?? [],
          memberLeagueIds: savedPrefs.memberLeagueIds ?? [],
        };
        setPrefs(restored);
        setHapticsEnabled(hz);
        // BEFORE the first request. Favourites, recents and the last known
        // memberships all come off the disk, so the opening pull can be scoped
        // correctly without waiting for a round trip. That ordering is the
        // whole reason the memberships are cached: the alternatives are a boot
        // that pulls nothing (and a scorekeeper's own league arrives late) or
        // one that pulls everything.
        scopeRef.current = computeScope(restored, null);
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
          // Concurrent with the first pull, not before it: the cached scope is
          // usually already right, and making boot wait on an RPC to find that
          // out would cost every launch a round trip. If the fresh answer names
          // a league the cache did not, the scope widens and one more pull
          // collects it.
          const membershipRefresh = (async () => {
            try {
              const fresh = await fetchMemberships(sb);
              if (fresh === null || cancelled) return false; // unknown, not "none"
              membersRef.current = fresh;
              const known = new Set(scopeRef.current ?? []);
              const added = fresh.filter(id => !known.has(id));
              setPrefs(prev => {
                const next = { ...prev, memberLeagueIds: fresh };
                void savePrefs(next);
                scopeRef.current = computeScope(next, fresh);
                return next;
              });
              return added.length > 0;
            } catch (e) {
              // A transport failure here is the same "offline" the pull reports;
              // the cached scope stands and the next launch tries again.
              warn('[sync] membership refresh failed:', (e as Error)?.message ?? String(e));
              return false;
            }
          })();

          const gotData = (await pullState('boot')).hadData;
          if (await membershipRefresh) {
            if (!cancelled) await pullState('boot-memberships');
          }
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
    // Both are stable for the life of the provider - `pullState`'s only
    // dependency (applySnapshot) has an empty dependency list, and
    // `computeScope` has none at all - so this still runs exactly once. They
    // are listed because they are used, not because they change.
  }, [pullState, computeScope]);

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

  /* ----------------------------------------------------------- the drain --
   * Send everything the server has not confirmed, oldest first.
   *
   * This is the piece the app never had. A push that failed was pinned in the
   * ledger and abandoned there - the sync badge said as much, in as many words
   * - so reconnecting sent nothing, and the next successful tap made the board
   * look right while the earlier taps stayed on the device only. Closing the
   * app then discarded them, because the boot pull hydrates the server's
   * snapshot over local state and, with the ledger gone, nothing objected.
   *
   * Three properties matter here and each is load-bearing:
   *
   *   ORDER      oldest first, and through the same `enqueuePush` chain as live
   *              taps, so a replayed insert cannot overtake the undo of it.
   *   IDEMPOTENT every replay is an upsert (or a delete) on an id minted on this
   *              device before the first attempt, so re-sending a write the
   *              server already took is a no-op. That is the whole answer to
   *              duplicate stats on retry - see pushPendingEntry.
   *   RESUMABLE  each entry is settled and persisted on its own. A drain
   *              interrupted by the connection dropping again, or by the app
   *              being closed, leaves the rest of the queue exactly as it was.
   *
   * `drainingRef` keeps one drain running at a time; reconnect, foreground and
   * pull-to-refresh can all ask at once. Entries are marked in flight
   * individually as well, so even a re-entrant caller cannot double-send one.
   */
  const drainingRef = useRef(false);
  const drainOutbox = useCallback(async (source: string): Promise<boolean> => {
    const sb = SYNC_ENABLED ? getSupabase() : null;
    if (!sb || drainingRef.current) return false;

    // Never replay a write for a game this device has since removed - a
    // rolled-back drop-in, a deleted game. See pruneOutbox: while nothing
    // retried, such an entry was harmless; replaying one re-creates rows the
    // person deliberately got rid of, pointing at teams and players that went
    // with them.
    const localGameIds = new Set<string>();
    const loadedLeagueIds = new Set<string>();
    for (const l of stateRef.current.leagues) {
      loadedLeagueIds.add(l.id);
      for (const g of l.games) localGameIds.add(g.id);
    }
    // Null scope means every league's games are in hand, so every absence is a
    // real deletion - today's behaviour. Once the pull is scoped, only leagues
    // the snapshot spoke for can be judged that way.
    const prunable = coveredRef.current === null ? null : loadedLeagueIds;
    if (pruneOutbox(localGameIds, prunable) > 0) persistOutbox();

    if (drainableEntries().length === 0) return false;

    drainingRef.current = true;
    let sent = 0;
    let lastFailure: unknown = null;
    try {
      setSyncState('saving');
      for (const entry of drainableEntries()) {
        if (!aliveRef.current) break;
        // Re-checked every iteration, not once at the top: the connection can
        // die in the middle of a hundred queued stats, and firing the remaining
        // ninety at a host we have just been told is unreachable helps nobody.
        if (isKnownOffline()) break;
        beginPush([entry.token]);
        persistOutbox();
        try {
          await enqueuePush(() => pushPendingEntry(sb, entry));
          confirmPending([entry.token]);
          noteReachable();
          sent++;
          trace('DRAIN', `sent ${entry.token} source=${source}`);
        } catch (e) {
          failPending([entry.token], e);
          lastFailure = e;
          trace('DRAIN', `FAILED ${entry.token} source=${source}`);
          // A transport failure will repeat for every remaining entry. Stop,
          // keep the queue intact, and let the probe restart it.
          if (noteUnreachable(e)) break;
        }
        persistOutbox();
      }
    } finally {
      drainingRef.current = false;
      persistOutbox();
    }

    if (lastFailure !== null) {
      setLastSyncError(describeSyncFailure(lastFailure));
      const detail = technicalSyncDetail(lastFailure);
      setLastSyncErrorDetail(detail ? `outbox: ${detail}` : null);
      setSyncState('error');
    } else if (sent > 0) {
      setLastSyncError(null);
      setLastSyncErrorDetail(null);
      setSyncState('saved');
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSyncState('idle'), 2000);
    } else {
      setSyncState('idle');
    }

    if (sent > 0) {
      // Retire what the server now demonstrably holds. Entries are removed from
      // the ledger only by a snapshot READ AFTER their confirmation that
      // actually contains them (see reconcileLeagueEvents), so this pull is not
      // cosmetic - without it the outbox keeps every drained entry, and every
      // relaunch replays writes the server already has.
      await pullState(`drain:${source}`);
      persistOutbox();
    }
    return sent > 0;
  }, [persistOutbox, pullState]);

  /**
   * Manual refresh for pull-to-refresh.
   *
   * Two changes from "re-pull the full server state now": it sends before it
   * reads, so a person who reconnects and pulls down gets their queued stats
   * away rather than only a fresh copy of the server's older truth; and it
   * reports what happened, because "nothing visibly occurred" was the entire
   * offline symptom.
   *
   * The known-offline short circuit is deliberate. A pull is five full table
   * reads, and firing them at a host we have already watched fail buys nothing
   * except a longer spinner before the same silence. `unknown` is NOT treated
   * as offline: at launch nobody has tried yet, and refusing on a guess would
   * be a worse bug than the one being fixed.
   */
  const refresh = useCallback(async (): Promise<RefreshOutcome> => {
    if (!SYNC_ENABLED) return 'local-only';
    if (isKnownOffline()) {
      // Not silent about it: one probe, so a connection that came back while
      // the app sat idle is picked up by the gesture the person just made.
      const sb = getSupabase();
      if (sb && await pingServer(sb)) noteReachable();
      else return 'offline';
    }
    await drainOutbox('manual-refresh');
    await pullState('manual-refresh');
    return isKnownOffline() ? 'offline' : 'refreshed';
  }, [drainOutbox, pullState]);

  /* --------------------------------------------------- reconnect handling --
   * Everything that can make a dead connection worth re-testing, in one place.
   *
   *   1. reachable again, with work queued   -> drain it
   *   2. believed offline                    -> probe on a backoff until it is
   *                                             not, since a device with
   *                                             nothing to send generates no
   *                                             evidence of its own
   *   3. the app came back to the foreground -> both of the above, now, rather
   *                                             than on whatever the timer had
   *                                             left. A backgrounded app's
   *                                             timers are throttled or frozen,
   *                                             so this is usually the moment
   *                                             an overnight reconnect is
   *                                             actually noticed.
   */
  /**
   * How many probe CYCLES this outage has spent - not this effect instance,
   * and not how many pings were refused.
   *
   * Both of those distinctions are the bug. The counter has to outlive the
   * effect, because the probe answering flips the status to 'online' and
   * unmounts the effect below; on a connection that answers reads but drops
   * writes - a captive portal, a proxy, a link that comes and goes - the very
   * next replay fails at the transport, flips it back to 'offline', and the
   * effect remounts with a fresh zero. And it has to count the CYCLE rather
   * than a refused ping, because in exactly that case the ping is not refused:
   * it is the write that fails, so a counter incremented only on a failed ping
   * would sit at zero for ever.
   *
   * Either way round, `probeDelay` never gets past its first step and the
   * documented 2s/4s/8s/15s/30s schedule degrades into a ping plus a failed
   * push every two seconds, indefinitely - two outbox writes per cycle and a
   * re-render of every screen showing the sync chip, while somebody is
   * scoring. Measured at 30 probes per minute, against both a dead host (with
   * the old pingServer) and a half-dead one (with the new one).
   */
  const probeAttempts = useRef(0);

  useEffect(() => {
    if (!SYNC_ENABLED || !ready || net !== 'online') return;
    void (async () => {
      await drainOutbox('reconnect');
      // The outage is over only if it is STILL over after the queue has been
      // through the connection. A drain that failed at the transport has
      // already put the status back to 'offline', and that is precisely the
      // case whose backoff must not be reset - it is the same outage, one
      // step further in.
      if (!isKnownOffline()) probeAttempts.current = 0;
    })();
  }, [net, ready, drainOutbox]);

  useEffect(() => {
    if (!SYNC_ENABLED || !ready || net !== 'offline') return;
    const sb = getSupabase();
    if (!sb) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const probe = async () => {
      if (cancelled) return;
      // Counted before the answer, because the cycle is what costs: this one
      // has now been spent whichever way it goes.
      probeAttempts.current++;
      const answered = await pingServer(sb);
      if (cancelled) return;
      // Flipping the status re-runs this effect's cleanup and starts the drain
      // above, so there is nothing else to do here on success. The count is
      // NOT cleared here: an answer to one cheap read is not yet evidence the
      // connection carries a write. The drain above clears it.
      if (answered) { noteReachable(); return; }
      timer = setTimeout(() => { void probe(); }, probeDelay(probeAttempts.current));
    };
    timer = setTimeout(() => { void probe(); }, probeDelay(probeAttempts.current));
    return () => { cancelled = true; clearTimeout(timer); };
  }, [net, ready]);

  useEffect(() => {
    if (!SYNC_ENABLED || !ready) return;
    const sub = RNAppState.addEventListener('change', s => {
      if (s !== 'active') return;
      const sb = getSupabase();
      if (!sb) return;
      void (async () => {
        if (isKnownOffline()) {
          if (await pingServer(sb)) noteReachable();
          return; // the reconnect effect drains from here
        }
        await drainOutbox('foreground');
      })();
    });
    return () => sub.remove();
  }, [ready, drainOutbox]);

  // Wrapped dispatch: apply the action locally, then push the resulting state
  // to Supabase. We compute the post-dispatch state inline via the reducer so
  // pushAction sees the exact rows we want to mirror — no React render gap.
  const dispatch = useCallback<React.Dispatch<Action>>((incoming) => {
    // HYDRATE and HYDRATE_LEAGUE are server→local; don't echo them back.
    // loadLeagueDetail already uses baseDispatch, so this is the guard for a
    // future caller reaching for the public dispatch - which would otherwise
    // push a whole league's tables back at the server that just sent them.
    if (incoming.t === 'HYDRATE' || incoming.t === 'HYDRATE_LEAGUE') { baseDispatch(incoming); return; }

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
    //
    // ONLY when there is a server. The ledger and the outbox exist to hold a
    // write open until a SERVER confirms it, and a build with no Supabase
    // credentials - the documented default, per the README - has no server, no
    // push, no pull and no drain. Every entry it recorded therefore stayed
    // unconfirmed forever: the ledger filled to MAX_ENTRIES (1000), and from
    // then on every single stat tap sorted a thousand entries and serialised
    // roughly 250 KB to AsyncStorage, on the live-scoring tap path, for a queue
    // that could never drain. Measured, not assumed - see the offline suite.
    const pushTokens = SYNC_ENABLED ? recordPending(action, prev, next) : [];
    trace('ACTION', `t=${action.t} game=${'gameId' in action ? action.gameId : '-'} tokens=${pushTokens.join(',') || 'none'}`);
    // On disk before the request goes out, so a write that is interrupted
    // between the tap and the reply - the app killed, the battery gone - is
    // still queued on the next launch rather than existing only in this
    // process's memory.
    if (pushTokens.length) persistOutbox();

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
        // The push is attempted even when the server is known to be
        // unreachable, and deliberately so. It fails immediately and costs
        // nothing, it keeps the online path byte-for-byte what it always was,
        // and - the reason that decides it - the all-or-nothing bundle writes
        // below depend on their own rejection to roll their local half back. A
        // short circuit here would leave a drop-in game half-created with
        // nothing to undo it, which is a worse bug than the request it saves.
        beginPush(pushTokens);
        void enqueuePush(() => pushAction(sb, action, next))
          .then(() => {
            // The server has it. The ledger entry stays until a snapshot read
            // after this moment confirms it — an older one is still in flight.
            confirmPending(pushTokens);
            noteReachable();
            persistOutbox();
            trace('PERSIST', `ok t=${action.t} tokens=${pushTokens.join(',') || 'none'}`);
            setLastSyncError(null);
            setLastSyncErrorDetail(null);
            setSyncState('saved');
            if (savedTimer.current) clearTimeout(savedTimer.current);
            savedTimer.current = setTimeout(() => setSyncState('idle'), 2000);
          })
          .catch((e) => {
            // Pin the entry: the scorekeeper's stat stays on the board and the
            // badge stays red, rather than the board quietly reverting later.
            // It also stays in the OUTBOX now, so "pinned" is no longer the end
            // of the story - the drain re-sends it when the server answers
            // again, and it survives the app being closed in the meantime.
            failPending(pushTokens, e);
            noteUnreachable(e);
            persistOutbox();
            trace('PERSIST', `FAILED t=${action.t} tokens=${pushTokens.join(',') || 'none'}`);
            // The reason, in two registers. The person gets a sentence they
            // can act on; the server's own words are dev-only, because they name
            // internal tables and mean nothing courtside. Which ACTION failed is
            // real diagnostic value, so it goes in the technical half - not into
            // the line a scorekeeper reads.
            setLastSyncError(describeSyncFailure(e));
            const detail = technicalSyncDetail(e);
            setLastSyncErrorDetail(detail ? `${action.t}: ${detail}` : null);
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
  // `persistOutbox` is itself a stable useCallback with no dependencies, so
  // naming it here does not make `dispatch` change identity between renders.
  }, [persistOutbox]);

  // Favorites: pure device-local preference. Toggle + persist; never synced.
  const toggleFav = useCallback((key: 'favLeagueIds' | 'favTeamIds', id: string) => {
    setPrefs(prev => {
      const cur = prev[key] ?? [];
      const list = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
      const next = { ...prev, [key]: list };
      void savePrefs(next);
      // Favouriting a league is a request to keep it up to date, so the scope
      // has to widen immediately rather than at the next launch.
      if (key === 'favLeagueIds') scopeRef.current = computeScope(next, membersRef.current);
      return next;
    });
  }, [computeScope]);
  /**
   * Newest first, capped. The cap is the point: this list decides how much every
   * future pull reads, so an unbounded one would rebuild the unbounded pull.
   */
  const RECENT_LEAGUES_MAX = 5;
  const noteLeagueOpened = useCallback((leagueId: string) => {
    setPrefs(prev => {
      const current = prev.recentLeagueIds ?? [];
      if (current[0] === leagueId) return prev; // already the most recent; no write
      const next = {
        ...prev,
        recentLeagueIds: [leagueId, ...current.filter(id => id !== leagueId)].slice(0, RECENT_LEAGUES_MAX),
      };
      void savePrefs(next);
      scopeRef.current = computeScope(next, membersRef.current);
      return next;
    });
  }, [computeScope]);

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

  // One derived answer for every screen that shows a sync state, so Home, the
  // live tracker and Settings cannot disagree about the same four facts.
  // Memoised on the inputs alone: `describeSync` is pure, and a fresh object
  // every render would re-render every consumer on every keystroke elsewhere.
  const sync = React.useMemo(
    () => describeSync({ enabled: SYNC_ENABLED, net, pending: pendingWrites, writeState: syncState, lastError: lastSyncError }),
    [net, pendingWrites, syncState, lastSyncError],
  );

  return <StoreCtx.Provider value={{ state, dispatch, ready, synced: SYNC_ENABLED, refresh,
    loadLeagueDetail, leaguesLoading, noteLeagueOpened, liveElsewhere, prefs, toggleFavLeague, toggleFavTeam, setHaptics, setNotifs, syncState, lastSyncError, lastSyncErrorDetail, net, pendingWrites, sync, prefsReady, initialSyncDone, dismissOnboarding }}>{children}</StoreCtx.Provider>;
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
