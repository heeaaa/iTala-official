/**
 * Boot, persistence, sync orchestration and the dispatch funnel.
 *
 * v1 put all of this plus the reducer in one 422-line file, which is why the
 * reducer was untestable. The reducer now lives in @itala/domain and the sync
 * engine in @itala/sync; this file is only the wiring.
 *
 * Boot order matters and is deliberate:
 *   1. open the local database and project state from it. THE APP IS USABLE
 *      FROM HERE, with no network involvement at all.
 *   2. wait up to 5s for an auth session before the first read. Without the
 *      wait the pull runs unauthenticated, row-level security returns an empty
 *      array WITH NO ERROR, and the device looks like it has lost everything.
 *      That bug cost v1 real debugging time.
 *   3. reconcile, then subscribe to realtime, then drain the outbox.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState as RNAppState } from 'react-native';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  initialState,
  project,
  reduce,
  type Action,
  type AppState,
  type Table,
} from '@itala/domain';
import {
  drainOnce,
  isSyncTable,
  planReconcile,
  planRealtime,
  type DrainReport,
  type Row,
} from '@itala/sync';
import { SqliteStore, openLocalDb } from '../db/sqlite';
import { SYNC_ENABLED, getSupabase } from '../sync/client';
import { SupabaseRemote } from '../sync/remote';

export interface SyncStatus {
  enabled: boolean;
  pending: number;
  rejected: number;
  /** Set after a drain that could not deliver. Cleared by a successful one. */
  stalled: boolean;
  lastSyncedAt: number | null;
}

interface StoreValue {
  state: AppState;
  ready: boolean;
  status: SyncStatus;
  dispatch(action: Action): Promise<void>;
  /** Pull and merge now. Safe at any time; never overwrites unsent work. */
  reconcile(): Promise<void>;
}

const StoreContext = createContext<StoreValue | null>(null);

const SESSION_WAIT_MS = 5_000;
const SESSION_POLL_MS = 200;
const RECONCILE_EVERY_MS = 120_000;
const DRAIN_RETRY_MS = 5_000;

export function StoreProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [state, setState] = useState<AppState>(initialState);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<SyncStatus>({
    enabled: SYNC_ENABLED,
    pending: 0,
    rejected: 0,
    stalled: false,
    lastSyncedAt: null,
  });

  const storeRef = useRef<SqliteStore | null>(null);
  const remoteRef = useRef<SupabaseRemote | null>(null);
  const stateRef = useRef<AppState>(state);
  const drainingRef = useRef(false);

  const refresh = useCallback(async () => {
    const store = storeRef.current;
    if (!store) return;
    const rows = await store.readAll();
    const rowsOf = (t: Table): Row[] => rows[t] ?? [];
    const next = project({
      leagues: rowsOf('leagues'),
      teams: rowsOf('teams'),
      players: rowsOf('players'),
      games: rowsOf('games'),
      events: rowsOf('events'),
    });
    stateRef.current = next;
    setState(next);
  }, []);

  const refreshCounts = useCallback(async (report?: DrainReport) => {
    const store = storeRef.current;
    if (!store) return;
    const counts = await store.counts();
    setStatus((s) => ({
      ...s,
      pending: counts.pending,
      rejected: counts.rejected,
      stalled: report ? report.blocked : s.stalled,
      lastSyncedAt: report && report.sent > 0 ? Date.now() : s.lastSyncedAt,
    }));
  }, []);

  const drain = useCallback(async () => {
    const store = storeRef.current;
    const remote = remoteRef.current;
    if (!store || !remote || drainingRef.current) return;
    drainingRef.current = true;
    try {
      const report = await drainOnce(store, remote, Date.now());
      await refreshCounts(report);
    } finally {
      drainingRef.current = false;
    }
  }, [refreshCounts]);

  const reconcile = useCallback(async () => {
    const store = storeRef.current;
    const remote = remoteRef.current;
    if (!store || !remote) return;
    const snapshot = await remote.fetchAll();
    if (!snapshot) return;
    const plan = planReconcile(await store.localIds(), snapshot, await store.pendingKeys());
    if (plan.ops.length > 0) {
      await store.applyRemote(plan.ops);
      await refresh();
    }
    setStatus((s) => ({ ...s, lastSyncedAt: Date.now() }));
  }, [refresh]);

  /** The only way domain state ever changes. */
  const dispatch = useCallback(
    async (action: Action) => {
      const store = storeRef.current;
      if (!store) return;

      const { state: next, ops } = reduce(stateRef.current, action);
      stateRef.current = next;
      setState(next);

      // Rows and the intent to send them, in one transaction. It is not
      // possible to end up having applied one without the other.
      if (ops.length > 0) {
        await store.commit(ops, SYNC_ENABLED ? ops : [], Date.now());
        await refreshCounts();
        void drain();
      }
    },
    [drain, refreshCounts],
  );

  // ---- boot ---------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const db = await openLocalDb();
      const store = new SqliteStore(db);
      storeRef.current = store;
      await refresh();
      await refreshCounts();
      if (cancelled) return;
      // Usable from here. Everything below is a bonus.
      setReady(true);

      if (!SYNC_ENABLED) return;
      const sb = getSupabase();
      if (!sb) return;
      remoteRef.current = new SupabaseRemote(sb);

      // Wait for the session BEFORE the first read. See the note at the top.
      const deadline = Date.now() + SESSION_WAIT_MS;
      let session = (await sb.auth.getSession()).data.session;
      while (!session && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, SESSION_POLL_MS));
        session = (await sb.auth.getSession()).data.session;
      }
      if (!session) {
        console.warn(
          '[itala] no auth session after 5s, skipping the initial pull. Check Anonymous sign-in is enabled in your Supabase project.',
        );
      }
      if (cancelled) return;

      await reconcile();
      await drain();
    })();

    return () => {
      cancelled = true;
    };
  }, [refresh, refreshCounts, reconcile, drain]);

  // ---- realtime -----------------------------------------------------------
  useEffect(() => {
    if (!ready || !SYNC_ENABLED) return;
    const sb = getSupabase();
    const store = storeRef.current;
    if (!sb || !store) return;

    let channel: RealtimeChannel | null = sb.channel('itala-sync');

    // The payload IS the change. v1 threw it away and re-downloaded five whole
    // tables on every event, including its own writes echoing back.
    for (const table of ['leagues', 'teams', 'players', 'games', 'events'] as const) {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        (payload) => {
          void (async () => {
            if (!isSyncTable(payload.table)) return;
            const pending = await store.pendingKeys();
            const op = planRealtime(
              {
                table: payload.table,
                eventType: payload.eventType,
                new: (payload.new ?? null) as Row | null,
                old: (payload.old ?? null) as { id?: string } | null,
              },
              pending,
            );
            if (!op) return;
            await store.applyRemote([op]);
            await refresh();
          })();
        },
      );
    }

    void channel.subscribe();
    return () => {
      if (channel) void sb.removeChannel(channel);
    };
  }, [ready, refresh]);

  // ---- keep trying, and catch up when the app comes back ------------------
  useEffect(() => {
    if (!ready || !SYNC_ENABLED) return;

    const retry = setInterval(() => void drain(), DRAIN_RETRY_MS);
    const periodic = setInterval(() => void reconcile(), RECONCILE_EVERY_MS);

    const sub = RNAppState.addEventListener('change', (s) => {
      if (s === 'active') {
        void reconcile();
        void drain();
      }
    });

    return () => {
      clearInterval(retry);
      clearInterval(periodic);
      sub.remove();
    };
  }, [ready, drain, reconcile]);

  const value = useMemo<StoreValue>(
    () => ({ state, ready, status, dispatch, reconcile }),
    [state, ready, status, dispatch, reconcile],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const v = useContext(StoreContext);
  if (!v) throw new Error('useStore must be used inside StoreProvider');
  return v;
}
