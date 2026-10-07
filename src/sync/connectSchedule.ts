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

// Every action is safe to send more than once: reads are reads, refreshLinks
// applies a revision-guarded snapshot, and start_connect_game and
// record_connect_default_game return the existing cg_ game instead of creating
// another (supabase/schema.sql). Content reports use the same 500 ms, 1 s waits.
const CONNECT_ATTEMPTS = 3;
const CONNECT_DEADLINE_MS = 15000;

/** What the person was doing, for the sentence they read if no answer arrives. */
function failureCopy(action: unknown): { what: string; timedOut: string } {
  if (action === 'startGame') return { what: 'Could not start this game.', timedOut: 'Starting this game timed out.' };
  if (action === 'recordDefault') {
    return { what: 'Could not save this default result.', timedOut: 'Saving this default result timed out.' };
  }
  return { what: 'Could not load the Connect schedule.', timedOut: 'Schedule request timed out.' };
}

type InvokeFailure =
  | { kind: 'answered'; message: string; status?: number }
  | { kind: 'unreached' | 'unavailable' | 'refused'; status?: number };

/**
 * Who answered. connect-schedule reports each of its own failures as JSON
 * `{ error }`, and that answer is final. Anything else never reached it:
 * supabase-js reports a request that got no response as FunctionsFetchError,
 * and Supabase's Edge Runtime can answer in the function's place - it sheds
 * requests with `503 {"code":"SUPABASE_EDGE_RUNTIME_SERVICE_DEGRADED"}` before
 * any function code runs. Both are worth sending again. Treating them as final
 * showed "check your connection" to people who had a working connection.
 */
async function readInvokeFailure(error: unknown): Promise<InvokeFailure> {
  const { name, context } = (error ?? {}) as { name?: unknown; context?: unknown };
  if (name === 'FunctionsFetchError') return { kind: 'unreached' };
  const response = context as Partial<Response> | undefined;
  const status = typeof response?.status === 'number' ? response.status : undefined;
  if (name === 'FunctionsRelayError') return { kind: 'unavailable', status };
  if (typeof response?.json === 'function') {
    try {
      const parsed = await response.json();
      if (typeof parsed?.error === 'string') return { kind: 'answered', message: parsed.error, status };
    } catch { /* Not the handler's JSON; classified by status below. */ }
  }
  return status !== undefined && status >= 500 ? { kind: 'unavailable', status } : { kind: 'refused', status };
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  if (!SYNC_ENABLED) throw new Error('Connect schedule needs the synced app configuration.');
  const sb = getSupabase();
  if (!sb) throw new Error('Sign in to see the Connect schedule.');
  const copy = failureCopy(body.action);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // One deadline bounds every send, every error body read and every wait
  // between attempts, so retrying never makes anyone wait longer than a single
  // request could, and nothing is sent after they were told it timed out.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${copy.timedOut} Check your connection and try again.`));
    }, CONNECT_DEADLINE_MS);
  });
  function bounded<V>(step: PromiseLike<V>): Promise<V> { return Promise.race([step, deadline]); }
  try {
    for (let attempt = 1; ; attempt++) {
      const { data, error } = await bounded(sb.functions.invoke('connect-schedule', { body, signal: controller.signal }));
      if (!error) return data as T;
      const failure = await bounded(readInvokeFailure(error));
      if (failure.kind === 'answered') throw Object.assign(new Error(failure.message), { status: failure.status });
      if (failure.kind === 'refused' || attempt >= CONNECT_ATTEMPTS) {
        const advice = failure.kind === 'unavailable'
          ? 'The schedule service is busy. Try again in a moment.'
          : 'Check your connection and try again.';
        throw Object.assign(new Error(`${copy.what} ${advice}`), { status: failure.status });
      }
      await bounded(new Promise(resolve => setTimeout(resolve, 500 * 2 ** (attempt - 1))));
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const result = await call<{ game?: { id: string; status: 'live' | 'final' } }>({
    action: 'startGame', leagueId, eventId, gameId, homeOnCourt, awayOnCourt,
  });
  // A 200 that is not the bridge's answer (a captive portal page, say) must not
  // surface as "Cannot read property 'status' of undefined" under Tip off.
  if (typeof result?.game?.id !== 'string') throw new Error(`${failureCopy('startGame').what} Check your connection and try again.`);
  return result.game;
}

/** Finish a published fixture by default without requiring a lineup or player events. */
export async function recordConnectDefaultGame(
  leagueId: string, eventId: string, gameId: string, winnerTeamId: string, score: number,
): Promise<{ id: string; status: 'final' }> {
  const result = await call<{ game?: { id: string; status: 'final' } }>({
    action: 'recordDefault', leagueId, eventId, gameId, winnerTeamId, score,
  });
  if (typeof result?.game?.id !== 'string') {
    throw new Error(`${failureCopy('recordDefault').what} Check your connection and try again.`);
  }
  return result.game;
}
