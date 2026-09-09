import AsyncStorage from '@react-native-async-storage/async-storage';
import { SupabaseClient } from '@supabase/supabase-js';
import { League } from '../types';
import { enqueuePush } from './pushQueue';
import { fetchLeagueDetail } from './sync';
import { devLog } from '../lib/log';

export interface RecSetupDraft { actorId: string; bundle: League }
const key = (actor: string) => `hoops.rec-setup.v1:${encodeURIComponent(actor)}`;
export async function loadRecSetup(actor: string): Promise<RecSetupDraft | null> {
  const raw = await AsyncStorage.getItem(key(actor));
  if (!raw) return null;
  const d = JSON.parse(raw) as RecSetupDraft;
  if (d.actorId !== actor || !d.bundle?.id || d.bundle.kind !== 'recreational'
      || !Array.isArray(d.bundle.games) || d.bundle.games.length !== 1
      || !Array.isArray(d.bundle.teams) || d.bundle.teams.length !== 2
      || !Array.isArray(d.bundle.players) || !d.bundle.players.length
      || d.bundle.games[0].createdBy !== actor
      || typeof d.bundle.games[0].id !== 'string'
      || !Number.isFinite(d.bundle.games[0].scheduledAt)
      || !d.bundle.teams.every(t => t && typeof t.id === 'string' && typeof t.name === 'string'
        && typeof t.color === 'string' && Array.isArray(t.playerIds) && t.playerIds.length
        && t.playerIds.every(id => d.bundle.players.some(p => p.id === id)))
      || !d.bundle.players.every(p => p && typeof p.id === 'string' && typeof p.name === 'string'
        && (p.number === undefined || typeof p.number === 'string'))
      || d.bundle.games[0].homeTeamId !== d.bundle.teams[0].id
      || d.bundle.games[0].awayTeamId !== d.bundle.teams[1].id) throw new Error('Invalid saved drop-in setup');
  return d;
}
export async function clearRecSetup(actor: string, expectedGameId?: string): Promise<void> {
  await active.get(actor)?.result.catch(() => {});
  if (expectedGameId) {
    const saved = await loadRecSetup(actor);
    if (saved && saved.bundle.games[0].id !== expectedGameId) throw new Error('Saved setup changed');
  }
  await AsyncStorage.removeItem(key(actor));
}
const active = new Map<string, { payload: string; result: Promise<boolean> }>();

// Read back the saved game before publishing it. A resumed receipt can belong
// to a game whose lineups, names or score have since changed on another device.
export async function readRecSetup(sb: SupabaseClient, draft: RecSetupDraft): Promise<League | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const detail = await Promise.race([fetchLeagueDetail(sb, draft.bundle.id),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 15000); })]);
    const game = detail?.games.find(g => g.id === draft.bundle.games[0].id);
    if (!detail || !game) return null;
    const teams = [detail.teams.find(t => t.id === game.homeTeamId), detail.teams.find(t => t.id === game.awayTeamId)];
    if (!teams[0] || !teams[1]) return null;
    const ids = new Set([...teams[0].playerIds, ...teams[1].playerIds]);
    if ([...ids].some(id => !detail.players.some(p => p.id === id))) return null;
    return { ...draft.bundle, games: [game], teams: [teams[0], teams[1]],
      players: detail.players.filter(p => ids.has(p.id)), events: detail.events.filter(e => e.gameId === game.id) };
  } finally { if (timer) clearTimeout(timer); }
}

export function saveRecSetup(sb: SupabaseClient, draft: RecSetupDraft): Promise<boolean> {
  const prior = active.get(draft.actorId);
  const payload = JSON.stringify(draft);
  if (prior) return prior.payload === payload ? prior.result : Promise.resolve(false);
  const run = (async () => {
    await AsyncStorage.setItem(key(draft.actorId), payload);
    const controller = new AbortController();
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The same deadline bounds the caller AND each await inside the queue.
    // Aborting fetch alone cannot release a stalled session or a transport
    // that ignores cancellation. Late replies cannot navigate or trigger retry.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true; reject(new Error('Setup timed out')); controller.abort();
      }, 15000);
    });
    try {
      return await Promise.race([
        enqueuePush(async () => {
          if (expired) return false;
          const b = draft.bundle, g = b.games[0];
          const args = { p_actor_id: draft.actorId, p_setup: {
            league_id: b.id, league_name: b.name, shared: !!b.isShared,
            created_at: g.scheduledAt, game_id: g.id, location: g.location ?? '',
            track_misses: g.trackMisses ?? null, track_turnovers: g.trackTurnovers ?? null,
            teams: b.teams.map(t => ({ id: t.id, name: t.name, color: t.color,
              players: t.playerIds.map(id => { const p = b.players.find(x => x.id === id);
                if (!p) throw new Error('Saved setup is missing a player');
                return { id: p.id, name: p.name, number: p.number ?? '' }; }),
            })),
          } };
          for (let attempt = 0; attempt < 2; attempt++) {
            if (expired) return false;
            const session = await Promise.race([sb.auth.getSession(), deadline]);
            if (expired || session.error || session.data.session?.user.id !== draft.actorId) return false;
            try {
              devLog('[rec-setup]', { phase: 'RPC_START', request: attempt + 1 });
              const result = await Promise.race([sb.rpc('rec_setup_game_once', args).abortSignal(controller.signal), deadline]);
              if (expired) return false;
              devLog('[rec-setup]', { phase: 'RPC_RESULT', request: attempt + 1, status: result.status,
                confirmed: !result.error && result.data?.game_id === g.id });
              if (!result.error && result.data?.game_id === g.id) return true;
              if (result.status !== 0) return false;
            } catch (error) {
              if (!(error instanceof TypeError) || !/network request failed|fetch failed|failed to fetch/i.test(error.message)) return false;
            }
          }
          return false;
        }),
        deadline,
      ]);
    } catch {
      return false;
    } finally { if (timer) clearTimeout(timer); }
  })();
  active.set(draft.actorId, { payload, result: run });
  void run.finally(() => { if (active.get(draft.actorId)?.result === run) active.delete(draft.actorId); }).catch(() => {});
  return run;
}
