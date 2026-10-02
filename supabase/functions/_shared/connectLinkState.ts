import type { BridgeDependencies } from './connectSchedule.ts';

export type LinkSnapshot = {
  leagueId: string; revision: number; checkedAt: number;
  events: { id: string; name: string; timezone: string; divisions: { id: string; name: string }[] }[];
};
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function validLinkSnapshot(value: unknown): value is LinkSnapshot {
  if (!value || typeof value !== 'object') return false;
  const s = value as LinkSnapshot;
  return typeof s.leagueId === 'string' && s.leagueId.length > 0 && s.leagueId.length <= 100
    && Number.isSafeInteger(s.revision) && s.revision > 0 && Number.isSafeInteger(s.checkedAt) && s.checkedAt > 0
    && Array.isArray(s.events) && s.events.length <= 100
    && new Set(s.events.map(e => e?.id)).size === s.events.length
    && s.events.every(e => uuid(e?.id) && typeof e.name === 'string' && typeof e.timezone === 'string'
      && Array.isArray(e.divisions) && e.divisions.length <= 100
      && e.divisions.every(d => uuid(d?.id) && typeof d.name === 'string'));
}

export async function applyLinkSnapshot(snapshot: LinkSnapshot, deps: BridgeDependencies): Promise<unknown> {
  const url = deps.env('SUPABASE_URL'), key = deps.env('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Link synchronization is not configured.');
  const result = await deps.fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/apply_connect_link_snapshot`, {
    method: 'POST', headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ p_league_id: snapshot.leagueId, p_events: snapshot.events,
      p_revision: snapshot.revision, p_checked_at: snapshot.checkedAt }), signal: AbortSignal.timeout(6000),
  });
  if (!result.ok) throw new Error('Could not save the Connect link status.');
  return result.json();
}

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
export async function handleConnectLinkState(req: Request, deps: BridgeDependencies): Promise<Response> {
  if (req.method !== 'POST') return respond({ error: 'Method not allowed.' }, 405);
  const secret = deps.env('CONNECT_LINK_SYNC_SECRET');
  if (!secret || secret.length < 32) return respond({ error: 'Link synchronization is not configured.' }, 503);
  const supplied = req.headers.get('x-connect-link-secret') ?? '';
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [expected, actual] = await Promise.all([digest(secret), digest(supplied)]);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected[i] ^ actual[i];
  if (difference) return respond({ error: 'Unauthorized.' }, 401);
  try {
    const reader = req.body?.getReader();
    if (!reader) return respond({ error: 'Invalid snapshot.' }, 400);
    let size = 0, body = '';
    const decoder = new TextDecoder();
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 131072) { await reader.cancel(); return respond({ error: 'Snapshot too large.' }, 413); }
      body += decoder.decode(part.value, { stream: true });
    }
    body += decoder.decode();
    let snapshot: unknown;
    try { snapshot = JSON.parse(body); } catch { return respond({ error: 'Invalid snapshot.' }, 400); }
    if (!validLinkSnapshot(snapshot)) return respond({ error: 'Invalid snapshot.' }, 400);
    const state = await applyLinkSnapshot(snapshot, deps);
    return respond({ state, ignored: state === null });
  } catch { return respond({ error: 'Could not synchronize the Connect link. Retry this delivery.' }, 502); }
}
