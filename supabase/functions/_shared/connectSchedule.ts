// iTala Connect is read here, never from the mobile bundle. The Connect key
// bypasses RLS, so published status and the mobile league link are checked
// explicitly before any record is returned or a fixture can be started.
type Row = Record<string, unknown>;
type Env = (name: string) => string | undefined;
export interface BridgeDependencies { env: Env; fetch: typeof fetch }

class BridgeError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const string = (v: unknown): string => typeof v === 'string' ? v : '';
const rows = (v: unknown): Row[] => Array.isArray(v) ? v.filter((r): r is Row => !!r && typeof r === 'object') : [];
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const inList = (ids: string[]) => `in.(${ids.map(id => `"${id.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')})`;

async function api(
  url: string, key: string, path: string, deps: BridgeDependencies,
  bearer = key, body?: unknown, extraHeaders: Record<string, string> = {},
  onResponse?: (response: Response) => void,
): Promise<unknown> {
  let response: Response;
  try {
    response = await deps.fetch(`${url.replace(/\/$/, '')}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        apikey: key, authorization: `Bearer ${bearer}`,
        ...extraHeaders,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new BridgeError(502, 'Could not reach the schedule service.');
  }
  if (!response.ok) {
    if (response.status === 401 && bearer !== key) throw new BridgeError(401, 'Sign in to view the schedule.');
    if (response.status === 403) throw new BridgeError(403, 'Access to this league was refused.');
    throw new BridgeError(502, 'The schedule service could not complete this request.');
  }
  onResponse?.(response);
  return response.status === 204 ? null : response.json();
}

async function table(
  url: string, key: string, name: string, query: Record<string, string>,
  deps: BridgeDependencies, bearer = key,
): Promise<Row[]> {
  const order: Record<string, string> = {
    leagues: 'id.asc', division_mobile_links: 'division_id.asc', divisions: 'id.asc',
    events: 'id.asc', teams: 'sort_order.asc,created_at.asc,id.asc',
    games: 'position.asc,id.asc', game_scores: 'game_id.asc',
    division_mobile_team_links: 'team_id.asc', score_sources: 'game_id.asc',
  };
  const pageSize = 500;
  const all: Row[] = [];
  let total: number | null = null;
  do {
    const offset = all.length;
    let pageTotal: number | null = null;
    const params = new URLSearchParams({ ...query, order: query.order ?? order[name], limit: String(pageSize), offset: String(offset) });
    const result = await api(url, key, `/rest/v1/${name}?${params}`, deps, bearer,
      undefined, { prefer: 'count=exact' }, response => {
        const match = /^(?:\d+-\d+|\*)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
        if (match) pageTotal = Number(match[1]);
      });
    if (!Array.isArray(result) || pageTotal === null || (total !== null && total !== pageTotal))
      throw new BridgeError(502, 'The schedule service returned an incomplete response.');
    total = pageTotal;
    const expected = Math.min(pageSize, total - offset);
    const page = rows(result);
    if (page.length !== expected || page.length !== result.length)
      throw new BridgeError(502, 'The schedule service returned an incomplete page.');
    all.push(...page);
  } while (all.length < total);
  return all;
}

// Keep PostgREST IN filters short even when an event has thousands of fixtures.
async function tableByIds(
  url: string, key: string, name: string, query: Record<string, string>, column: string,
  ids: string[], deps: BridgeDependencies,
): Promise<Row[]> {
  const all: Row[] = [];
  for (let i = 0; i < ids.length; i += 80)
    all.push(...await table(url, key, name, { ...query, [column]: inList(ids.slice(i, i + 80)) }, deps));
  return all;
}

type PlayoffSource = { type: 'seed'; rank: number } | { type: 'winner'; bracketGameId: string };
export interface ConnectFixture {
  id: string; divisionId: string; day: string | null; time: string | null; court: number | null;
  homeTeamId: string | null; awayTeamId: string | null; label: string; type: string;
  score1: number | null; score2: number | null; mobileGameId: string | null;
  playoff: boolean; bracketGameId: string | null;
  team1Source: PlayoffSource | null; team2Source: PlayoffSource | null;
}
function source(v: unknown): PlayoffSource | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Row;
  if (s.type === 'seed' && Number.isInteger(s.rank) && Number(s.rank) > 0) return { type: 'seed', rank: Number(s.rank) };
  if (s.type === 'winner' && string(s.bracketGameId)) return { type: 'winner', bracketGameId: string(s.bracketGameId) };
  return null;
}

// Port of Connect's resolveAllPlayoffs/computeStandings. The known fixture ids
// remain stable; teams on future playoff fixtures can resolve as scores arrive.
export function resolvePlayoffs<G extends ConnectFixture>(games: G[], divisions: { id: string; teamIds: string[] }[]): G[] {
  const out = games.map(g => ({ ...g }));
  const seeds = new Map<string, string[]>();
  for (const d of divisions) {
    const group = out.filter(g => g.divisionId === d.id && g.type === 'group' && !g.playoff && g.homeTeamId && g.awayTeamId);
    if (!group.length || group.some(g => g.score1 === null || g.score2 === null)) { seeds.set(d.id, []); continue; }
    const record = new Map(d.teamIds.map((id, i) => [id, { id, i, wins: 0, pf: 0, pa: 0 }]));
    for (const g of group) {
      const home = record.get(g.homeTeamId!); const away = record.get(g.awayTeamId!);
      if (!home || !away) continue;
      home.pf += g.score1!; home.pa += g.score2!;
      away.pf += g.score2!; away.pa += g.score1!;
      if (g.score1! > g.score2!) home.wins++;
      if (g.score2! > g.score1!) away.wins++;
    }
    seeds.set(d.id, [...record.values()]
      .sort((a, b) => b.wins - a.wins || (b.pf - b.pa) - (a.pf - a.pa) || b.pf - a.pf || a.i - b.i)
      .map(r => r.id));
  }
  const resolve = (s: PlayoffSource | null, ranks: string[]): string | null => {
    if (!s) return null;
    if (s.type === 'seed') return ranks[s.rank - 1] ?? null;
    const prior = out.find(g => g.bracketGameId === s.bracketGameId);
    if (!prior || prior.score1 === null || prior.score2 === null) return null;
    return prior.score1 > prior.score2 ? prior.homeTeamId : prior.score2 > prior.score1 ? prior.awayTeamId : null;
  };
  for (const g of out) if (g.playoff && g.bracketGameId && g.team1Source && g.team2Source) {
    const ranks = seeds.get(g.divisionId) ?? [];
    g.homeTeamId = resolve(g.team1Source, ranks);
    g.awayTeamId = resolve(g.team2Source, ranks);
  }
  return out;
}

async function linksForLeague(leagueId: string, connect: string, secret: string, deps: BridgeDependencies) {
  const links = await table(connect, secret, 'division_mobile_links', {
    select: 'division_id', league_id: `eq.${leagueId}`,
  }, deps);
  const ids = links.map(l => string(l.division_id)).filter(Boolean);
  if (!ids.length) return { divisions: [], events: [] };
  const divisions = await tableByIds(connect, secret, 'divisions', {
    select: 'id,event_id,name,sort_order',
  }, 'id', ids, deps);
  const eventIds = [...new Set(divisions.map(d => string(d.event_id)).filter(Boolean))];
  const events = await tableByIds(connect, secret, 'events', {
    select: 'id,name,status,timezone,court_names', status: 'eq.published',
  }, 'id', eventIds, deps);
  const published = new Set(events.map(e => string(e.id)));
  return { divisions: divisions.filter(d => published.has(string(d.event_id))), events };
}

async function schedule(leagueId: string, eventId: string, connect: string, secret: string, deps: BridgeDependencies) {
  const linked = await linksForLeague(leagueId, connect, secret, deps);
  const event = linked.events.find(e => e.id === eventId);
  if (!event) throw new BridgeError(404, 'No published linked event was found.');
  const divisions = linked.divisions.filter(d => d.event_id === eventId);
  const divisionIds = divisions.map(d => string(d.id));
  if (!divisionIds.length) throw new BridgeError(404, 'No linked division was found.');
  const [teams, games, scores, teamLinks] = await Promise.all([
    tableByIds(connect, secret, 'teams', { select: 'id,division_id,name,sort_order', order: 'sort_order.asc,created_at.asc,id.asc' }, 'division_id', divisionIds, deps),
    tableByIds(connect, secret, 'games', {
      select: 'id,division_id,day,start_time,court,team1_id,team2_id,label,type,is_playoff,bracket_game_id,team1_source,team2_source,position',
      event_id: `eq.${eventId}`, order: 'position.asc,id.asc',
    }, 'division_id', divisionIds, deps),
    table(connect, secret, 'game_scores', { select: 'game_id,s1,s2', event_id: `eq.${eventId}` }, deps),
    tableByIds(connect, secret, 'division_mobile_team_links', { select: 'division_id,team_id,mobile_team_id' }, 'division_id', divisionIds, deps),
  ]);
  const gameIds = games.map(g => string(g.id));
  const sources = await tableByIds(connect, secret, 'score_sources', {
    select: 'game_id,mobile_game_id,league_id', league_id: `eq.${leagueId}`,
  }, 'game_id', gameIds, deps);
  const byScore = new Map(scores.map(s => [string(s.game_id), s]));
  const bySource = new Map(sources.map(s => [string(s.game_id), string(s.mobile_game_id)]));
  const fixtures: ConnectFixture[] = games.map(g => {
    const score = byScore.get(string(g.id));
    return {
      id: string(g.id), divisionId: string(g.division_id),
      day: string(g.day) || null, time: string(g.start_time).slice(0, 5) || null,
      court: typeof g.court === 'number' ? g.court : null,
      homeTeamId: string(g.team1_id) || null, awayTeamId: string(g.team2_id) || null,
      label: string(g.label), type: string(g.type), playoff: g.is_playoff === true,
      bracketGameId: string(g.bracket_game_id) || null,
      team1Source: source(g.team1_source), team2Source: source(g.team2_source),
      score1: typeof score?.s1 === 'number' ? score.s1 : null,
      score2: typeof score?.s2 === 'number' ? score.s2 : null,
      mobileGameId: bySource.get(string(g.id)) || null,
    };
  });
  const divisionTeams = divisions.map(d => ({
    id: string(d.id), teamIds: teams.filter(t => t.division_id === d.id).map(t => string(t.id)),
  }));
  const mapping = new Map(teamLinks.map(l => [string(l.team_id), string(l.mobile_team_id)]));
  return {
    event: {
      id: string(event.id), name: string(event.name), timezone: string(event.timezone),
      courtNames: Array.isArray(event.court_names) ? event.court_names : [],
    },
    divisions: divisions.map(d => ({ id: string(d.id), name: string(d.name) })),
    teams: teams.map(t => ({
      id: string(t.id), divisionId: string(t.division_id), name: string(t.name),
      mobileTeamId: mapping.get(string(t.id)) || null,
    })),
    games: resolvePlayoffs(fixtures, divisionTeams),
  };
}

export async function handleConnectSchedule(req: Request, deps: BridgeDependencies): Promise<Response> {
  if (req.method !== 'POST') return respond({ error: 'Method not allowed.' }, 405);
  const mobile = deps.env('SUPABASE_URL'); const mobileKey = deps.env('SUPABASE_ANON_KEY');
  const connect = deps.env('CONNECT_SUPABASE_URL'); const secret = deps.env('CONNECT_SUPABASE_SERVICE_ROLE_KEY');
  if (!mobile || !mobileKey || !connect || !secret) return respond({ error: 'Schedule integration is not configured.' }, 503);
  const bearer = /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
  if (!bearer) return respond({ error: 'Sign in to view the schedule.' }, 401);
  try {
    await api(mobile, mobileKey, '/auth/v1/user', deps, bearer);
    let body: Row;
    try { body = await req.json() as Row; } catch { throw new BridgeError(400, 'Invalid schedule request.'); }
    const action = string(body.action), leagueId = string(body.leagueId);
    if (!leagueId || leagueId.length > 100) throw new BridgeError(400, 'Choose a league.');
    const league = await table(mobile, mobileKey, 'leagues', { select: 'id,kind', id: `eq.${leagueId}` }, deps, bearer);
    if (league.length !== 1 || league[0].kind !== 'league') throw new BridgeError(404, 'League not found.');
    if (action === 'listEvents') {
      const linked = await linksForLeague(leagueId, connect, secret, deps);
      return respond({ events: linked.events.map(e => ({
        id: string(e.id), name: string(e.name), timezone: string(e.timezone),
        divisions: linked.divisions.filter(d => d.event_id === e.id).map(d => ({ id: string(d.id), name: string(d.name) })),
      })) });
    }
    const eventId = string(body.eventId);
    if (!isUuid(eventId)) throw new BridgeError(400, 'Choose an event.');
    if (action === 'getDivisionSchedule') return respond(await schedule(leagueId, eventId, connect, secret, deps));
    if (action === 'startGame') {
      const gameId = string(body.gameId);
      if (!isUuid(gameId)) throw new BridgeError(400, 'Choose a fixture.');
      const current = await schedule(leagueId, eventId, connect, secret, deps);
      const fixture = current.games.find(g => g.id === gameId);
      if (!fixture || !fixture.day || !fixture.time || !fixture.homeTeamId || !fixture.awayTeamId
        || fixture.score1 !== null || fixture.score2 !== null || fixture.mobileGameId) {
        throw new BridgeError(409, 'This fixture is no longer available to start. Refresh the schedule.');
      }
      const home = current.teams.find(t => t.id === fixture.homeTeamId)?.mobileTeamId;
      const away = current.teams.find(t => t.id === fixture.awayTeamId)?.mobileTeamId;
      if (!home || !away || home === away) throw new BridgeError(409, 'Both Connect teams must be linked to different mobile teams.');
      const result = await api(mobile, mobileKey, '/rest/v1/rpc/start_connect_game', deps, bearer, {
        p_league_id: leagueId, p_connect_game_id: gameId, p_home_team_id: home, p_away_team_id: away,
        p_home_on_court: body.homeOnCourt, p_away_on_court: body.awayOnCourt,
        p_location: fixture.court ? string(current.event.courtNames[fixture.court - 1]) || `Court ${fixture.court}` : null,
      });
      return respond({ game: result });
    }
    throw new BridgeError(400, 'Unknown schedule action.');
  } catch (error) {
    if (error instanceof BridgeError) return respond({ error: error.message }, error.status);
    return respond({ error: 'Could not load the schedule. Try again.' }, 502);
  }
}
