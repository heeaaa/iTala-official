'use strict';
const assert = require('node:assert/strict');
const {
  handleConnectSchedule, isConnectResult, nextScheduleDay, nowInZone, connectMobileGameId,
  canStartFreeformGame, connectAdminImportUrl, CONNECT_SITE_URL, resolvePlayoffs,
} = require(process.env.ITALA_BUNDLE);

const E = '11111111-1111-4111-8111-111111111111';
const DRAFT = '22222222-2222-4222-8222-222222222222';
const D1 = '33333333-3333-4333-8333-333333333333';
const D2 = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const G = [1, 2, 3, 4, 5].map(n => `66666666-6666-4666-8666-${String(n).padStart(12, '0')}`);
const T = [1, 2, 3, 4].map(n => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`);
const data = {
  division_mobile_links: [
    { division_id: D1, league_id: 'mobile-1' }, { division_id: D2, league_id: 'mobile-1' },
    { division_id: OTHER, league_id: 'mobile-other' },
  ],
  divisions: [
    { id: D1, event_id: E, name: 'Men', sort_order: 0 },
    { id: D2, event_id: E, name: 'Women', sort_order: 1 },
    { id: OTHER, event_id: DRAFT, name: 'Draft', sort_order: 0 },
  ],
  events: [
    { id: E, name: 'BC League', status: 'published', timezone: 'America/Vancouver', court_names: ['Main'] },
    { id: DRAFT, name: 'Unpublished', status: 'draft', timezone: 'Pacific/Auckland', court_names: ['Draft'] },
  ],
  teams: T.map((id, i) => ({ id, division_id: i < 2 ? D1 : D2, name: `Team ${i + 1}`, sort_order: i })),
  division_mobile_team_links: T.map((id, i) => ({ division_id: i < 2 ? D1 : D2, team_id: id, mobile_team_id: `m${i + 1}` })),
  games: [
    { id: G[0], event_id: E, division_id: D1, day: '2026-09-05', start_time: '09:00:00', court: 1, team1_id: T[0], team2_id: T[1], label: '', type: 'group', is_playoff: false, position: 0 },
    { id: G[1], event_id: E, division_id: D1, day: '2026-09-05', start_time: '10:00:00', court: 1, team1_id: T[0], team2_id: T[1], label: '', type: 'group', is_playoff: false, position: 1 },
    { id: G[2], event_id: E, division_id: D2, day: '2026-10-03', start_time: '09:00:00', court: 1, team1_id: T[2], team2_id: T[3], label: '', type: 'group', is_playoff: false, position: 2 },
    { id: G[3], event_id: E, division_id: D2, day: '2026-10-03', start_time: '10:00:00', court: 1, team1_id: T[2], team2_id: T[3], label: '', type: 'group', is_playoff: false, position: 3 },
    { id: G[4], event_id: E, division_id: D2, day: null, start_time: null, court: null, team1_id: null, team2_id: null, label: 'Final', type: 'final', is_playoff: false, position: 4 },
  ],
  game_scores: [
    { game_id: G[0], event_id: E, s1: 72, s2: 60 },
    { game_id: G[1], event_id: E, s1: 20, s2: 0 }, // Connect-only default
    { game_id: G[3], event_id: E, s1: 12, s2: null }, // incomplete score entry
  ],
  score_sources: [{ game_id: G[0], league_id: 'mobile-1', mobile_game_id: 'old-mobile-id' }],
};

const calls = [];
let rpcCalls = 0;
let defaultRpcCalls = 0;
let stored;
let truncateGames = false;
let omitCount = false;
let discoveryFailure = false, registryFailure = false, registryWrites = 0;
let linkSnapshot = { leagueId: 'mobile-1', revision: 20, checkedAt: 1000,
  events: [{ id: E, name: 'BC League', timezone: 'America/Vancouver', divisions: [{ id: D1, name: 'Men' }] }] };
function filtered(list, search) {
  return list.filter(row => [...search.entries()].every(([key, condition]) => {
    if (['select', 'order', 'limit', 'offset'].includes(key)) return true;
    if (condition.startsWith('eq.')) return String(row[key]) === condition.slice(3);
    if (condition.startsWith('in.(')) return condition.slice(4, -1).replaceAll('"', '').split(',').includes(String(row[key]));
    throw Error(`Unhandled filter ${key}: ${condition}`);
  }));
}
async function fakeFetch(input, options) {
  const url = new URL(input);
  calls.push({ url, options });
  if (url.pathname === '/auth/v1/user') return Response.json({ id: 'user-1' });
  if (url.pathname === '/rest/v1/leagues') {
    return Response.json(filtered([{ id: 'mobile-1', kind: 'league' }], url.searchParams),
      { headers: { 'content-range': '0-0/1' } });
  }
  if (url.pathname === '/rest/v1/rpc/start_connect_game') {
    rpcCalls++;
    const body = JSON.parse(options.body);
    assert.equal(body.p_league_id, 'mobile-1');
    assert.equal(body.p_home_team_id, 'm3');
    assert.equal(body.p_away_team_id, 'm4');
    stored ??= { id: connectMobileGameId(G[2]), status: 'live' };
    return Response.json(stored);
  }
  if (url.pathname === '/rest/v1/rpc/authorize_connect_game') {
    assert.equal(options.headers.authorization, 'Bearer mobile-service');
    return new Response(null, { status: 204 });
  }
  if (url.pathname === '/rest/v1/rpc/connect_mobile_link_snapshot') {
    assert.equal(url.host, 'connect.invalid');
    assert.equal(options.headers.authorization, 'Bearer connect-service');
    assert.deepEqual(JSON.parse(options.body), { p_league_id: 'mobile-1' });
    return discoveryFailure ? new Response(null, { status: 503 }) : Response.json(linkSnapshot);
  }
  if (url.pathname === '/rest/v1/rpc/apply_connect_link_snapshot') {
    registryWrites++;
    assert.equal(url.host, 'mobile.invalid');
    assert.equal(options.headers.authorization, 'Bearer mobile-service');
    assert.equal(JSON.parse(options.body).p_revision, 20);
    return registryFailure ? new Response(null, { status: 503 })
      : Response.json({ events: linkSnapshot.events, revision: 21, checkedAt: 1100 });
  }
  if (url.pathname === '/rest/v1/rpc/record_connect_default_game') {
    defaultRpcCalls++;
    const body = JSON.parse(options.body);
    assert.equal(body.p_league_id, 'mobile-1');
    assert.equal(body.p_home_team_id, 'm3');
    assert.equal(body.p_away_team_id, 'm4');
    assert.equal(body.p_winner_team_id, 'm4');
    assert.equal(body.p_default_score, 30);
    return Response.json({ id: connectMobileGameId(G[2]), status: 'final' });
  }
  const table = url.pathname.split('/').pop();
  if (table in data) {
    const full = filtered(data[table], url.searchParams);
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Number(url.searchParams.get('limit') || 500);
    const page = full.slice(offset, offset + limit);
    const result = table === 'games' && truncateGames && page.length ? page.slice(0, 1) : page;
    const range = result.length ? `${offset}-${offset + result.length - 1}/${full.length}` : `*/${full.length}`;
    return Response.json(result, { headers: omitCount ? {} : { 'content-range': range } });
  }
  throw Error(`Unexpected request ${url}`);
}
const deps = {
  env: key => ({ SUPABASE_URL: 'https://mobile.invalid', SUPABASE_ANON_KEY: 'mobile-anon',
    SUPABASE_SERVICE_ROLE_KEY: 'mobile-service',
    CONNECT_SUPABASE_URL: 'https://connect.invalid', CONNECT_SUPABASE_SERVICE_ROLE_KEY: 'connect-service' })[key],
  fetch: fakeFetch,
};
const request = body => new Request('https://mobile.invalid/functions/v1/connect-schedule', {
  method: 'POST', headers: { authorization: 'Bearer user-jwt' }, body: JSON.stringify(body),
});
async function ask(body) {
  const response = await handleConnectSchedule(request(body), deps);
  return { status: response.status, body: await response.json() };
}

(async () => {
  const unauth = await handleConnectSchedule(new Request('https://mobile.invalid', { method: 'POST', body: '{}' }), deps);
  assert.equal(unauth.status, 401);
  const linked = await ask({ action: 'listEvents', leagueId: 'mobile-1' });
  assert.equal(linked.status, 200);
  assert.deepEqual(linked.body.events.map(e => e.id), [E]);
  assert.deepEqual(linked.body.events[0].divisions.map(d => d.id), [D1, D2]);
  assert.ok(calls.some(c => c.url.pathname.endsWith('/events') && c.url.searchParams.get('status') === 'eq.published'));
  assert.equal((await ask({ action: 'getDivisionSchedule', leagueId: 'mobile-1', eventId: DRAFT })).status, 404);

  const schedule = await ask({ action: 'getDivisionSchedule', leagueId: 'mobile-1', eventId: E });
  assert.equal(schedule.status, 200);
  assert.equal(schedule.body.event.timezone, 'America/Vancouver');
  assert.equal(schedule.body.games.length, 5);
  assert.equal(schedule.body.games[0].mobileGameId, 'old-mobile-id');
  assert.equal(schedule.body.games[1].score1, 20);
  assert.equal(schedule.body.games[1].score2, 0);
  assert.equal(schedule.body.games[2].score1, null);
  assert.equal(schedule.body.games[2].time, '09:00');
  assert.ok(schedule.body.teams.some(t => t.mobileTeamId === 'm4'));

  for (const gameId of [G[0], G[1], G[3], G[4]]) {
    const result = await ask({ action: 'startGame', leagueId: 'mobile-1', eventId: E, gameId,
      homeOnCourt: ['p1'], awayOnCourt: ['p2'] });
    assert.equal(result.status, 409, `game ${gameId} must not start`);
  }
  assert.equal(rpcCalls, 0);
  for (const invalid of [{ winnerTeamId: 'other', score: 30 }, { winnerTeamId: 'm4', score: 0 },
    { winnerTeamId: 'm4', score: 30.5 }]) {
    const refused = await ask({ action: 'recordDefault', leagueId: 'mobile-1', eventId: E,
      gameId: G[2], ...invalid });
    assert.equal(refused.status, 400);
  }
  assert.equal(defaultRpcCalls, 0);
  const defaulted = await ask({ action: 'recordDefault', leagueId: 'mobile-1', eventId: E,
    gameId: G[2], winnerTeamId: 'm4', score: 30 });
  assert.equal(defaulted.status, 200);
  assert.deepEqual(defaulted.body.game, { id: connectMobileGameId(G[2]), status: 'final' });
  assert.equal(defaultRpcCalls, 1);
  for (let n = 0; n < 2; n++) {
    const started = await ask({ action: 'startGame', leagueId: 'mobile-1', eventId: E, gameId: G[2],
      homeOnCourt: ['p1'], awayOnCourt: ['p2'] });
    assert.equal(started.status, 200);
    assert.equal(started.body.game.id, connectMobileGameId(G[2]));
  }
  assert.equal(rpcCalls, 2); // the mobile RPC is idempotent; both taps receive one game id
  assert.equal(isConnectResult(schedule.body.games[1]), true);
  assert.equal(isConnectResult(schedule.body.games[2]), false);
  assert.equal(nextScheduleDay(schedule.body.games, '2026-09-29T12:00'), '2026-10-03');
  assert.equal(nowInZone('America/Vancouver', new Date('2026-09-29T05:00:00Z')).slice(0, 10), '2026-09-28');
  assert.equal(nowInZone('Pacific/Auckland', new Date('2026-09-29T05:00:00Z')).slice(0, 10), '2026-09-29');
  assert.ok(!JSON.stringify(schedule.body).includes('connect-service'));
  assert.equal(CONNECT_SITE_URL, 'https://connect.itala.fyi');
  assert.equal(connectAdminImportUrl('mobile 1'), `${CONNECT_SITE_URL}/admin/import/mobile%201`);
  const linkedLeague = { id: 'mobile-1', kind: 'league', connectLink: { events: [{ id: E }], revision: 1, checkedAt: 1 } };
  const requestsBeforePolicy = calls.length;
  assert.equal(canStartFreeformGame({ ...linkedLeague, kind: 'recreational' }, true), true);
  assert.equal(canStartFreeformGame(linkedLeague, false), true);
  assert.equal(canStartFreeformGame({ ...linkedLeague, connectLink: { events: [], revision: 2, checkedAt: 2 } }, true), true);
  assert.equal(canStartFreeformGame(linkedLeague, true), false);
  assert.equal(calls.length, requestsBeforePolicy, 'game-start policy reads local league status without requesting Connect');

  const refreshed = await ask({ action: 'refreshLinks', leagueId: 'mobile-1' });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.revision, 21, 'manual discovery returns the latest mobile registry revision');
  assert.equal(registryWrites, 1);
  discoveryFailure = true;
  assert.equal((await ask({ action: 'refreshLinks', leagueId: 'mobile-1' })).status, 502);
  assert.equal(registryWrites, 1, 'failed discovery never writes an empty status');
  discoveryFailure = false;
  const validSnapshot = linkSnapshot;
  linkSnapshot = { ...linkSnapshot, leagueId: 'different-league' };
  assert.equal((await ask({ action: 'refreshLinks', leagueId: 'mobile-1' })).status, 502);
  assert.equal(registryWrites, 1, 'mismatched source responses cannot update another league');
  linkSnapshot = validSnapshot;
  registryFailure = true;
  assert.equal((await ask({ action: 'refreshLinks', leagueId: 'mobile-1' })).status, 502);
  registryFailure = false;

  const playoff = {
    id: G[4], divisionId: D1, type: 'final', playoff: true, bracketGameId: G[4],
    homeTeamId: T[0], awayTeamId: T[1], team1Source: null, team2Source: { type: 'seed', rank: 2 },
    score1: null, score2: null,
  };
  assert.deepEqual(resolvePlayoffs([playoff], [{ id: D1, teamIds: [T[0], T[1]] }])
    .map(g => [g.homeTeamId, g.awayTeamId]), [[T[0], T[1]]],
  'a playoff with incomplete source metadata retains its stored teams');
  const seeded = resolvePlayoffs([
    { ...playoff, id: G[1], type: 'group', playoff: false, score1: 12, score2: 10 },
    { ...playoff, homeTeamId: null, awayTeamId: null,
      team1Source: { type: 'seed', rank: 1 }, team2Source: { type: 'seed', rank: 2 } },
  ], [{ id: D1, teamIds: [T[0], T[1]] }]);
  assert.deepEqual([seeded[1].homeTeamId, seeded[1].awayTeamId], [T[0], T[1]],
    'complete seeded playoff metadata still resolves from round-robin scores');

  truncateGames = true;
  assert.equal((await ask({ action: 'getDivisionSchedule', leagueId: 'mobile-1', eventId: E })).status, 502);
  truncateGames = false;
  omitCount = true;
  assert.equal((await ask({ action: 'getDivisionSchedule', leagueId: 'mobile-1', eventId: E })).status, 502);
  omitCount = false;

  const originalGames = data.games;
  const originalScores = data.game_scores;
  for (const count of [999, 1000, 1001]) {
    data.games = Array.from({ length: count }, (_, i) => ({
      ...originalGames[2], id: `88888888-8888-4888-8888-${String(i).padStart(12, '0')}`, position: i,
    }));
    data.game_scores = data.games.map(g => ({ game_id: g.id, event_id: E, s1: 10, s2: 8 }));
    const firstCall = calls.length;
    const large = await ask({ action: 'getDivisionSchedule', leagueId: 'mobile-1', eventId: E });
    assert.equal(large.status, 200, `schedule with ${count} fixtures must load`);
    assert.equal(large.body.games.length, count);
    assert.equal(large.body.games[count - 1].score1, 10);
    const gameReads = calls.slice(firstCall).filter(c => c.url.pathname.endsWith('/games'));
    assert.equal(gameReads.length, Math.ceil(count / 500));
    const scoreReads = calls.slice(firstCall).filter(c => c.url.pathname.endsWith('/game_scores'));
    assert.equal(scoreReads.length, Math.ceil(count / 500));
    const sourceReads = calls.slice(firstCall).filter(c => c.url.pathname.endsWith('/score_sources'));
    assert.ok(sourceReads.length > 1, 'source filters must be chunked');
    assert.ok(sourceReads.every(c => c.url.searchParams.get('game_id').split(',').length <= 80));
  }
  data.games = originalGames;
  data.game_scores = originalScores;
  console.log('✓ Connect schedule bridge: published links, guarded starts, drop-in isolation, playoff parity, complete pagination at 999/1000/1001');
})().catch(e => { console.error(e); process.exitCode = 1; });
