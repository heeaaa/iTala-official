// Server-to-server read for iTala Connect Reports. Connect sends its own dedicated
// secret, never a user session, and the service key used below bypasses RLS, so
// this handler is the whole gate: GET only, the secret compared in constant time,
// one league, at most 100 final games, and only the columns Reports reads. It
// never writes: every request it makes is a PostgREST GET.

type Row = Record<string, unknown>;
type Env = (name: string) => string | undefined;
export interface ReportsDependencies {
  env: Env;
  fetch: typeof fetch;
  now?: () => Date;
}

/** Mobile ids are base-36 or `cg_<uuid>`; Connect accepts exactly this alphabet. */
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_GAMES = 100;
const MAX_EVENTS = 20000;
const PAGE = 500;
const IN_CHUNK = 100;

class ReportsError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const inList = (ids: string[]) => `in.(${ids.map(id => `"${id}"`).join(',')})`;

async function sameSecret(expected: string, supplied: string): Promise<boolean> {
  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(expected), digest(supplied)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

/** Every row of a filtered table, page by page, refusing a short or shifting read. */
async function rows(
  base: string, key: string, table: string, query: Record<string, string>,
  deps: ReportsDependencies, max = Number.POSITIVE_INFINITY,
): Promise<Row[]> {
  const all: Row[] = [];
  let total: number | null = null;
  do {
    const params = new URLSearchParams({ ...query, order: 'id.asc', limit: String(PAGE), offset: String(all.length) });
    let response: Response;
    try {
      response = await deps.fetch(`${base}/rest/v1/${table}?${params}`, {
        method: 'GET',
        headers: { apikey: key, authorization: `Bearer ${key}`, prefer: 'count=exact' },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ReportsError(502, 'Could not read the mobile records.');
    }
    if (!response.ok) throw new ReportsError(502, 'Could not read the mobile records.');
    const match = /^(?:\d+-\d+|\*)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    const pageTotal = match ? Number(match[1]) : null;
    if (pageTotal === null || (total !== null && total !== pageTotal))
      throw new ReportsError(502, 'The mobile records changed while they were read. Try again.');
    if (pageTotal > max) throw new ReportsError(413, 'Too many records for one report. Choose fewer games.');
    total = pageTotal;
    const page: unknown = await response.json();
    if (!Array.isArray(page) || page.length !== Math.min(PAGE, total - all.length)
      || page.some(row => !row || typeof row !== 'object'))
      throw new ReportsError(502, 'The mobile records changed while they were read. Try again.');
    all.push(...(page as Row[]));
  } while (all.length < total);
  return all;
}

const text = (row: Row, key: string) => (typeof row[key] === 'string' ? (row[key] as string) : '');
const id = (row: Row, key: string) => ID.test(text(row, key));

/** `?leagueId=...&gameIds=a,b,c`: one league, 1 to 100 distinct game ids. */
function selection(url: URL): { leagueId: string; gameIds: string[] } {
  const leagueId = url.searchParams.get('leagueId') ?? '';
  const gameIds = (url.searchParams.get('gameIds') ?? '').split(',');
  if (!ID.test(leagueId) || gameIds.length < 1 || gameIds.length > MAX_GAMES
    || !gameIds.every(gameId => ID.test(gameId)) || new Set(gameIds).size !== gameIds.length)
    throw new ReportsError(400, 'Choose one league and between 1 and 100 games.');
  return { leagueId, gameIds };
}

export async function handleConnectReports(req: Request, deps: ReportsDependencies): Promise<Response> {
  if (req.method !== 'GET') return respond({ error: 'Method not allowed.' }, 405);
  const secret = deps.env('CONNECT_REPORTS_READ_SECRET');
  if (!secret || secret.length < 32) return respond({ error: 'Reports reading is not configured.' }, 503);
  if (!(await sameSecret(secret, req.headers.get('x-connect-reports-secret') ?? '')))
    return respond({ error: 'Unauthorized.' }, 401);
  const base = (deps.env('SUPABASE_URL') ?? '').replace(/\/$/, '');
  const key = deps.env('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!base || !key) return respond({ error: 'Reports reading is not configured.' }, 503);

  try {
    const { leagueId, gameIds } = selection(new URL(req.url));
    const league = `eq.${leagueId}`;
    // Only finished games count: a live or scheduled one has no final stats yet.
    const games = await rows(base, key, 'games', {
      select: 'id,league_id,home_team_id,away_team_id,status,default_winner_team_id',
      league_id: league, status: 'eq.final', id: inList(gameIds),
    }, deps, MAX_GAMES);
    const finalIds = games.map(game => text(game, 'id'));
    const events = finalIds.length
      ? await rows(base, key, 'events', {
        select: 'id,league_id,game_id,team_id,player_id,type', league_id: league, game_id: inList(finalIds),
      }, deps, MAX_EVENTS)
      : [];
    const playerIds = [...new Set(events.map(event => text(event, 'player_id')).filter(Boolean))];
    const players: Row[] = [];
    for (let i = 0; i < playerIds.length; i += IN_CHUNK) {
      if (!playerIds.slice(i, i + IN_CHUNK).every(playerId => ID.test(playerId)))
        throw new ReportsError(502, 'A mobile record could not be read for Reports.');
      players.push(...await rows(base, key, 'players', {
        select: 'id,league_id,name', league_id: league, id: inList(playerIds.slice(i, i + IN_CHUNK)),
      }, deps));
    }

    // Connect refuses the whole read if any record breaks its contract, so check it here
    // first and say so plainly, instead of sending something Connect cannot use.
    const finalSet = new Set(finalIds);
    const valid = games.every(game => ['id', 'home_team_id', 'away_team_id'].every(k => id(game, k))
        && text(game, 'league_id') === leagueId && game.status === 'final' && gameIds.includes(text(game, 'id'))
        && (game.default_winner_team_id == null || id(game, 'default_winner_team_id')))
      && events.every(event => ['id', 'game_id', 'team_id'].every(k => id(event, k))
        && text(event, 'league_id') === leagueId && finalSet.has(text(event, 'game_id'))
        && (event.player_id == null || id(event, 'player_id'))
        && text(event, 'type').length >= 1 && text(event, 'type').length <= 80)
      && players.every(player => id(player, 'id') && text(player, 'league_id') === leagueId
        && typeof player.name === 'string' && player.name.length <= 200)
      && new Set(events.map(event => text(event, 'id'))).size === events.length;
    if (!valid) throw new ReportsError(502, 'A mobile record could not be read for Reports.');

    return respond({
      leagueId,
      games: games.map(game => ({
        id: game.id, league_id: game.league_id, home_team_id: game.home_team_id, away_team_id: game.away_team_id,
        status: game.status, default_winner_team_id: game.default_winner_team_id ?? null,
      })),
      events: events.map(event => ({
        id: event.id, league_id: event.league_id, game_id: event.game_id, team_id: event.team_id,
        player_id: event.player_id ?? null, type: event.type,
      })),
      players: players.map(player => ({ id: player.id, league_id: player.league_id, name: player.name })),
      readAt: (deps.now ?? (() => new Date()))().toISOString(),
    });
  } catch (error) {
    if (error instanceof ReportsError) return respond({ error: error.message }, error.status);
    return respond({ error: 'Could not prepare the Reports read.' }, 502);
  }
}
