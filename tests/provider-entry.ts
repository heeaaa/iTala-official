// Bundle entry for the provider suite: the real StoreProvider component, plus
// the storage and module-level state a relaunch has to reset around it.
export { StoreProvider, useStore, reducer, stampActionIds, __resetSyncPrimitives } from '../src/store/StoreProvider';
export { loadState, saveState, loadOutbox, saveOutbox, loadPrefs, savePrefs } from '../src/store/storage';
export { outboxSnapshot, unsyncedCount, pendingCount, appliedSnapshotAt } from '../src/sync/pendingEvents';
export { netStatus, isKnownOffline } from '../src/sync/connectivity';
export { SYNC_ENABLED } from '../src/sync/supabase';
