// Bundle entry for the test harness: re-exports the pure logic under test.
export {
  reducer, stampActionIds, __resetSyncPrimitives,
} from '../src/store/StoreProvider';
export {
  beginSnapshot, acceptSnapshot, appliedSnapshotAt,
  confirmPending, failPending, recordPending,
  reconcileLeagueEvents, reconcileLeagueGames,
  compareEvents, insertEvent, lastEventOf, sortEvents, pendingCount,
  beginPush, drainableEntries, outboxSnapshot, pruneOutbox, restoreOutbox, unsyncedCount,
} from '../src/sync/pendingEvents';
export { pushAction, fetchAllState, fetchLeagueDetail, fetchLiveGames, fetchMemberships, pushPendingEntry, pingServer } from '../src/sync/sync';
export {
  isKnownOffline, netStatus, noteReachable, noteUnreachable, probeDelay, subscribeNet,
  __resetNet,
} from '../src/sync/connectivity';
export { describeSync } from '../src/sync/syncStatus';
export { enqueuePush } from '../src/sync/pushQueue';
export * from '../src/lib/stats';
export * from '../src/lib/rosterParse';
export * from '../src/lib/liveInput';
export { gameCardOptions } from '../src/lib/cardSpecs';
export { devLog, devWarn, warn as relWarn } from '../src/lib/log';
export {
  setScopedError, clearScopedError, errorForScope, describeAuthFailure,
  diagnoseAuthFailure, isNetworkFailure, sessionRecoveryPlan,
} from '../src/store/authErrors';
export { uid } from '../src/lib/format';
