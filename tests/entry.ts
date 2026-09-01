// Bundle entry for the test harness: re-exports the pure logic under test.
export {
  reducer, stampActionIds, __resetSyncPrimitives,
} from '../src/store/StoreProvider';
export {
  beginSnapshot, confirmPending, failPending, recordPending, reconcileLeagueEvents,
  compareEvents, insertEvent, lastEventOf, sortEvents, pendingCount,
} from '../src/sync/pendingEvents';
export { pushAction, fetchAllState } from '../src/sync/sync';
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
