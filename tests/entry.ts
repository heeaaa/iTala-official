// The harness stubs react-native (tests/harness/pkg/rn); this import is how the
// device controls below reach it.
import * as ReactNative from 'react-native';
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
export { isTabletSync } from '../src/lib/deviceClass';

// Test-only device controls. They live on the harness react-native stub
// (tests/harness/pkg/rn), not on the real module, so the cast is the honest
// way to say "this only exists under the harness". isTabletSync reads
// Platform/Dimensions on every call, so setting the device here is enough -
// nothing is cached at module scope.
type Size = { width: number; height: number };
type DeviceEnv = { os?: 'ios' | 'android'; isPad?: boolean; screen?: Size; window?: Size };
const harnessRN = ReactNative as unknown as {
  __setDeviceEnv(env: DeviceEnv): void;
  __resetDeviceEnv(): void;
};
export const __setDeviceEnv = (env: DeviceEnv): void => harnessRN.__setDeviceEnv(env);
export const __resetDeviceEnv = (): void => harnessRN.__resetDeviceEnv();
