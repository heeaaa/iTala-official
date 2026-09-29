import { getSupabase, SYNC_ENABLED } from './supabase';

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
    try {
      const response = (error as { context?: Response }).context;
      if (response?.json) {
        const parsed = await response.json();
        if (typeof parsed?.error === 'string') message = parsed.error;
      }
    } catch { /* Retain the safe generic error. */ }
    throw new Error(message);
  }
  return data as T;
}

export async function listConnectEvents(leagueId: string): Promise<ConnectEventRef[]> {
  const result = await call<{ events: ConnectEventRef[] }>({ action: 'listEvents', leagueId });
  return result.events;
}

export async function getConnectSchedule(leagueId: string, eventId: string): Promise<ConnectSchedule> {
  return call<ConnectSchedule>({ action: 'getDivisionSchedule', leagueId, eventId });
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
