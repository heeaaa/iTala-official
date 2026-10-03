import { getSupabase, SYNC_ENABLED } from './supabase';
import type { ConnectLinkState, League } from '../types';

export interface ConnectEventRef {
  id: string;
  name: string;
  timezone: string;
  divisions: { id: string; name: string }[];
}
export interface ConnectFixture {
  id: string;
  divisionId: string;
  day: string | null;
  time: string | null;
  court: number | null;
  homeTeamId: string | null;
  awayTeamId: string | null;
  label: string;
  type: string;
  score1: number | null;
  score2: number | null;
  mobileGameId: string | null;
  playoff: boolean;
}
export interface ConnectSchedule {
  event: { id: string; name: string; timezone: string; courtNames: string[] };
  divisions: { id: string; name: string }[];
  teams: { id: string; divisionId: string; name: string; mobileTeamId: string | null }[];
  games: ConnectFixture[];
}

export const connectMobileGameId = (connectGameId: string) => `cg_${connectGameId}`;
export const CONNECT_SITE_URL = 'https://itala-connect.netlify.app';
export const connectAdminImportUrl = (leagueId: string) =>
  `${CONNECT_SITE_URL}/admin/import/${encodeURIComponent(leagueId)}`;

export function isConnectResult(g: Pick<ConnectFixture, 'score1' | 'score2' | 'mobileGameId'>): boolean {
  // One entered side is not a final, but it is still somebody's score entry.
  // Never offer Start over a partial score or an approved mobile result.
  return g.score1 !== null || g.score2 !== null || !!g.mobileGameId;
}

export function nextScheduleDay(games: readonly ConnectFixture[], nowLocal: string): string | null {
  const days = [...new Set(games.filter(g => g.day && g.time).map(g => g.day!))].sort();
  const next = games.filter(g => g.day && g.time && !isConnectResult(g) && `${g.day}T${g.time}` >= nowLocal)
    .sort((a, b) => `${a.day}T${a.time}`.localeCompare(`${b.day}T${b.time}`))[0];
  return next?.day ?? days[days.length - 1] ?? null;
}

/** The fixture's wall-clock date/time, independent of this phone's timezone. */
export function nowInZone(timezone: string, date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    const part = (name: string) => parts.find(p => p.type === name)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
  } catch {
    return '';
  }
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  if (!SYNC_ENABLED) throw new Error('Connect schedule needs the synced app configuration.');
  const sb = getSupabase();
  if (!sb) throw new Error('Sign in to see the Connect schedule.');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let data: unknown;
  let error: unknown;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Schedule request timed out. Check your connection and try again.'));
      }, 15000);
    });
    ({ data, error } = await Promise.race([
      sb.functions.invoke('connect-schedule', { body, signal: controller.signal }), deadline,
    ]));
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (error) {
    let message = 'Could not load the Connect schedule. Check your connection and try again.';
    let status: number | undefined;
    try {
      const response = (error as { context?: Response }).context;
      status = response?.status;
      if (response?.json) {
        const parsed = await response.json();
        if (typeof parsed?.error === 'string') message = parsed.error;
      }
    } catch { /* Retain the safe generic error. */ }
    throw Object.assign(new Error(message), { status });
  }
  return data as T;
}

export async function listConnectEvents(leagueId: string): Promise<ConnectEventRef[]> {
  const result = await call<{ events: ConnectEventRef[] }>({ action: 'listEvents', leagueId });
  return result.events;
}

/** Game screens only read persisted league metadata. Discovery belongs in Schedule/settings.
 * The mobile database guards new game inserts if a device has an older league revision.
 */
export function canStartFreeformGame(
  league: Pick<League, 'id' | 'kind' | 'connectLink'>,
  syncEnabled = SYNC_ENABLED,
): boolean {
  return league.kind === 'recreational' || !syncEnabled || !league.connectLink?.events.length;
}

const linkChecks = new Map<string, { at: number; value?: ConnectLinkState; error?: Error }>();
const linkRequests = new Map<string, Promise<ConnectLinkState>>();

/** Explicit guest refresh reads the mobile registry, never the Connect project. */
export async function fetchConnectLinkState(leagueId: string): Promise<ConnectLinkState | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb.from('leagues')
    .select('connect_events,connect_link_revision,connect_link_checked_at').eq('id', leagueId).single();
  if (error) throw new Error('Could not refresh the league’s Connect status.');
  if (data?.connect_link_checked_at == null) return null;
  return { events: data.connect_events, revision: data.connect_link_revision, checkedAt: data.connect_link_checked_at };
}

/** Coalesce owner discovery and throttle successful AND failed visits. Explicit refresh retries. */
export async function refreshConnectLinkState(leagueId: string, force = false): Promise<ConnectLinkState> {
  const pending = linkRequests.get(leagueId);
  if (pending) return pending;
  const previous = linkChecks.get(leagueId);
  if (!force && previous && Date.now() - previous.at < 5 * 60 * 1000) {
    if (previous.error) throw previous.error;
    if (previous.value) return previous.value;
  }
  const request = (async () => {
    try {
      let value: ConnectLinkState;
      try { value = await call<ConnectLinkState>({ action: 'refreshLinks', leagueId }); }
      catch (error) {
        // During a coordinated upgrade an older bridge/source database may not support refreshLinks.
        // A successful legacy lookup is an unversioned hint; it never overrides server-owned revisions.
        const status = (error as { status?: number }).status;
        if (!status || ![400, 404, 405, 501, 502, 503].includes(status)) throw error;
        const events = await listConnectEvents(leagueId);
        value = { events, revision: 0, checkedAt: Date.now() };
      }
      if (!Array.isArray(value?.events) || !Number.isSafeInteger(value.revision) || value.revision < 0
        || !Number.isFinite(value.checkedAt)) throw new Error('Could not refresh the Connect link.');
      linkChecks.set(leagueId, { at: Date.now(), value });
      return value;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('Could not refresh the Connect link.');
      linkChecks.set(leagueId, { at: Date.now(), error: failure });
      throw failure;
    }
  })();
  linkRequests.set(leagueId, request);
  try { return await request; } finally { linkRequests.delete(leagueId); }
}

const scheduleRequests = new Map<string, Promise<ConnectSchedule>>();
export async function getConnectSchedule(leagueId: string, eventId: string): Promise<ConnectSchedule> {
  const key = JSON.stringify([leagueId, eventId]);
  const pending = scheduleRequests.get(key);
  if (pending) return pending;
  const request = call<ConnectSchedule>({ action: 'getDivisionSchedule', leagueId, eventId });
  scheduleRequests.set(key, request);
  try { return await request; } finally { scheduleRequests.delete(key); }
}

export async function startConnectGame(
  leagueId: string, eventId: string, gameId: string,
  homeOnCourt: string[], awayOnCourt: string[],
): Promise<{ id: string; status: 'live' | 'final' }> {
  const result = await call<{ game: { id: string; status: 'live' | 'final' } }>({
    action: 'startGame', leagueId, eventId, gameId, homeOnCourt, awayOnCourt,
  });
  return result.game;
}

/** Finish a published fixture by default without requiring a lineup or player events. */
export async function recordConnectDefaultGame(
  leagueId: string, eventId: string, gameId: string, winnerTeamId: string, score: number,
): Promise<{ id: string; status: 'final' }> {
  const result = await call<{ game: { id: string; status: 'final' } }>({
    action: 'recordDefault', leagueId, eventId, gameId, winnerTeamId, score,
  });
  return result.game;
}
