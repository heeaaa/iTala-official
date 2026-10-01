import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ConnectEventRef, ConnectSchedule } from './connectSchedule';

const KEY_PREFIX = 'itala.connect.schedule.v1.';
const FRESH_FOR_MS = 5 * 60 * 1000;

export type CachedConnectSchedule = {
  events: ConnectEventRef[];
  eventsUpdatedAt: number;
  schedules: Record<string, { value: ConnectSchedule; updatedAt: number }>;
};

const memory = new Map<string, CachedConnectSchedule>();
const reads = new Map<string, Promise<CachedConnectSchedule | null>>();
const writes = new Map<string, Promise<void>>();

const keyFor = (leagueId: string) => `${KEY_PREFIX}${leagueId}`;

export function peekConnectScheduleCache(leagueId: string): CachedConnectSchedule | null {
  return memory.get(leagueId) ?? null;
}

export async function readConnectScheduleCache(leagueId: string): Promise<CachedConnectSchedule | null> {
  const inMemory = peekConnectScheduleCache(leagueId);
  if (inMemory) return inMemory;
  const existing = reads.get(leagueId);
  if (existing) return existing;
  const pending = (async () => {
    try {
      const raw = await AsyncStorage.getItem(keyFor(leagueId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CachedConnectSchedule;
      if (!Array.isArray(parsed.events) || !Number.isFinite(parsed.eventsUpdatedAt)
        || !parsed.events.every(event => typeof event?.id === 'string')
        || !parsed.schedules || typeof parsed.schedules !== 'object' || Array.isArray(parsed.schedules)) return null;
      if (Object.entries(parsed.schedules).some(([id, entry]) => {
        const value = entry?.value;
        return !Number.isFinite(entry?.updatedAt) || value?.event?.id !== id
          || typeof value?.event?.timezone !== 'string' || !Array.isArray(value?.event?.courtNames)
          || !Array.isArray(value?.games) || !Array.isArray(value?.teams) || !Array.isArray(value?.divisions);
      })) return null;
      const entry = memory.get(leagueId) ?? parsed;
      memory.set(leagueId, entry);
      return entry;
    } catch { return null; } // A cache miss must still allow a network fetch.
  })();
  reads.set(leagueId, pending);
  try { return await pending; }
  finally { reads.delete(leagueId); }
}

export function isConnectScheduleCacheFresh(cache: CachedConnectSchedule, eventId?: string, now = Date.now()): boolean {
  const eventsAge = now - cache.eventsUpdatedAt;
  if (eventsAge < 0 || eventsAge >= FRESH_FOR_MS) return false;
  if (!eventId) return true;
  const entry = cache.schedules[eventId];
  if (!entry) return false;
  const scheduleAge = now - entry.updatedAt;
  return scheduleAge >= 0 && scheduleAge < FRESH_FOR_MS;
}

export function saveConnectScheduleCache(leagueId: string, events: ConnectEventRef[], schedule?: ConnectSchedule): void {
  const previous = memory.get(leagueId);
  const now = Date.now();
  const linkedIds = new Set(events.map(event => event.id));
  const schedules = Object.fromEntries(Object.entries(previous?.schedules ?? {})
    .filter(([eventId]) => linkedIds.has(eventId)));
  if (schedule) schedules[schedule.event.id] = { value: schedule, updatedAt: now };
  const entry = { events, eventsUpdatedAt: now, schedules };
  memory.set(leagueId, entry);
  const preceding = writes.get(leagueId) ?? Promise.resolve();
  const write = preceding.catch(() => {}).then(() => AsyncStorage.setItem(keyFor(leagueId), JSON.stringify(entry)));
  writes.set(leagueId, write);
  void write.catch(() => {}); // A storage failure must not hide a fetched schedule.
}
