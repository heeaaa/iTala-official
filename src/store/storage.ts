import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, LocalPrefs } from '../types';
import { OutboxEntry } from '../sync/pendingEvents';

const KEY = 'hoops.state.v1';

export async function loadState(): Promise<AppState | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as AppState) : null;
  } catch {
    return null;
  }
}

export async function saveState(state: AppState): Promise<void> {
  try {
    // Strip the transient per-game redo stash — it must never persist or sync.
    const clean = { ...state, leagues: state.leagues.map(({ _redo, ...l }) => l) };
    await AsyncStorage.setItem(KEY, JSON.stringify(clean));
  } catch {
    // best-effort; a failed write should never crash a live game
  }
}

// ---------------------------------------------------------------------------
// The outbox: local writes the server has not confirmed, on disk.
//
// A SEPARATE key from the state above, deliberately, and the write ORDER
// between the two is the thing that makes the pair safe without a transaction.
//
// AsyncStorage gives no atomicity across keys, so a crash can land between the
// two writes and one of the two possible inconsistencies has to be chosen. They
// are not equally bad:
//
//   outbox ahead of state   an entry for an event the saved state does not
//                           have. Harmless and self-healing: reconciliation
//                           re-adds the row from the entry's own copy of it.
//   state ahead of outbox   an event on the device with nothing queued to send
//                           it. That is the original bug - a stat that lives on
//                           screen and reaches the server never.
//
// So the outbox is written FIRST, before the state that produced it, and the
// window can only ever fall on the harmless side.
//
// A missing key reads as an empty outbox, which is exactly what a device
// upgrading from a build that had none should see - the state key is untouched
// and loads as it always did.
// ---------------------------------------------------------------------------
const OUTBOX_KEY = 'hoops.outbox.v1';

export async function loadOutbox(): Promise<OutboxEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(OUTBOX_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // Storage is not a trusted input. An older or corrupted value must produce
    // an empty outbox rather than an array of undefineds for the restore to
    // pick through; restoreOutbox validates each row, this validates the shape
    // around them.
    return Array.isArray(parsed) ? (parsed as OutboxEntry[]) : [];
  } catch {
    return [];
  }
}

export async function saveOutbox(entries: readonly OutboxEntry[]): Promise<void> {
  try {
    // An empty outbox is removed rather than stored as "[]": there is no state
    // to keep, and a device that syncs cleanly should not carry a stale key.
    if (entries.length === 0) await AsyncStorage.removeItem(OUTBOX_KEY);
    else await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(entries));
  } catch {
    // Best-effort, like saveState. A storage failure must never take a live
    // game down - and the in-memory ledger is still protecting the same writes.
  }
}

const PREFS_KEY = 'hoops.prefs.v1';

export async function loadPrefs(): Promise<LocalPrefs | null> {
  try {
    const raw = await AsyncStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as LocalPrefs) : null;
  } catch {
    return null;
  }
}

export async function savePrefs(prefs: LocalPrefs): Promise<void> {
  try {
    await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // best-effort
  }
}
