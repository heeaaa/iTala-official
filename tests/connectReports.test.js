'use strict';
// iTala Connect Reports reader (supabase/functions/connect-reports): the gate (GET only, a
// dedicated secret compared in constant time), the selection (one league, final games
// only, events of those games, the players they name), complete pagination, bounded
// size, and that nothing but PostgREST GETs ever leaves the handler.
const assert = require('node:assert/strict');
const { handleConnectReports } = require(process.env.ITALA_BUNDLE);

const SECRET = 'r'.repeat(16) + 'S'.repeat(16) + '-reports';
const BASE = 'https://mobile.example.supabase.co';
const env = { SUPABASE_URL: `${BASE}/`, SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-value', CONNECT_REPORTS_READ_SECRET: SECRET };
const now = () => new Date('2026-10-07T01:00:00.000Z');

const L = 'lg1abc';
const data = {
  games: [
    { id: 'cg_11111111-1111-4111-8111-111111111111', league_id: L, home_team_id: 'th', away_team_id: 'ta', status: 'final', default_winner_team_id: null, period: 4 },
    { id: 'g2final', league_id: L, home_team_id: 'th', away_team_id: 'ta', status: 'final', default_winner_team_id: null },
    { id: 'g3live', league_id: L, home_team_id: 'th', away_team_id: 'ta', status: 'live', default_winner_team_id: null },
    { id: 'g4other', league_id: 'otherleague', home_team_id: 'x1', away_team_id: 'x2', status: 'final', default_winner_team_id: null },
    { id: 'g5unasked', league_id: L, home_team_id: 'th', away_team_id: 'ta', status: 'final', default_winner_team_id: null },
  ],
  events: [
    { id: 'e1', league_id: L, game_id: 'cg_11111111-1111-4111-8111-111111111111', team_id: 'th', player_id: 'p1', type: 'fg2_make', period: 1, ts: 1 },
    { id: 'e2', league_id: L, game_id: 'cg_11111111-1111-4111-8111-111111111111', team_id: 'ta', player_id: null, type: 'ft_make', period: 1, ts: 2 },
    { id: 'e3', league_id: L, game_id: 'g2final', team_id: 'ta', player_id: 'p2', type: 'fg3_make', period: 2, ts: 3 },
    { id: 'e4', league_id: L, game_id: 'g3live', team_id: 'th', player_id: 'p3', type: 'fg2_make', period: 1, ts: 4 },
    { id: 'e5', league_id: 'otherleague', game_id: 'g4other', team_id: 'x1', player_id: 'p9', type: 'fg2_make', period: 1, ts: 5 },
  ],
  players: [
    { id: 'p1', league_id: L, name: 'Māia Te Aroha', number: '7' },
    { id: 'p2', league_id: L, name: 'Rua Parata', number: '11' },
    { id: 'p3', league_id: L, name: 'Live Only', number: '3' },
    { id: 'p4', league_id: L, name: 'Never Scored', number: '9' },
    { id: 'p9', league_id: 'otherleague', name: 'Other League', number: '1' },
  ],
};

let calls = [];
let fail = null; // { table, status } | { table, shift: true } | { table, network: true } | { table, rows }
function matches(row, params) {
  return [...params.entries()].every(([key, condition]) => {
    if (['select', 'order', 'limit', 'offset'].includes(key)) return true;
    if (condition.startsWith('eq.')) return String(row[key]) === condition.slice(3);
    if (condition.startsWith('in.(')) return condition.slice(4, -1).split(',').map(v => v.replace(/^"|"$/g, '')).includes(String(row[key]));
    throw Error(`Unhandled filter ${key}=${condition}`);
  });
}
async function fakeFetch(input, options) {
  const url = new URL(input);
  calls.push({ url, options });
  const table = url.pathname.replace('/rest/v1/', '');
  if (fail?.table === table && fail.network) throw new TypeError('network down');
  if (fail?.table === table && fail.status) return new Response('{}', { status: fail.status });
  const source = fail?.table === table && fail.rows ? fail.rows : data[table];
  const select = url.searchParams.get('select').split(',');
  const found = source.filter(row => matches(row, url.searchParams)).sort((a, b) => a.id.localeCompare(b.id));
  const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
  const page = found.slice(offset, offset + limit).map(row => Object.fromEntries(select.map(k => [k, row[k] ?? null])));
  const total = fail?.table === table && fail.shift && offset > 0 ? found.length + 1 : found.length;
  return Response.json(page, { headers: { 'content-range': page.length ? `${offset}-${offset + page.length - 1}/${total}` : `*/${total}` } });
}

const ask = (query = `leagueId=${L}&gameIds=cg_11111111-1111-4111-8111-111111111111,g2final,g3live,g4other,gmissing`, init = {}) =>
  new Request(`https://mobile.example.supabase.co/functions/v1/connect-reports?${query}`, {
    method: 'GET', headers: { 'x-connect-reports-secret': SECRET }, ...init,
  });
const call = (req, overrides = {}) => handleConnectReports(req, { env: name => ({ ...env, ...overrides })[name], fetch: fakeFetch, now });
async function body(response) { return response.json(); }

(async () => {
  // The gate: method, configuration and secret are checked before anything is read.
  calls = [];
  assert.equal((await call(ask(undefined, { method: 'POST', body: '{}' }))).status, 405);
  assert.equal((await call(ask(), { CONNECT_REPORTS_READ_SECRET: undefined })).status, 503);
  assert.equal((await call(ask(), { CONNECT_REPORTS_READ_SECRET: 'too-short' })).status, 503, 'a short secret is refused as unconfigured');
  assert.equal((await call(ask(undefined, { headers: {} }))).status, 401);
  assert.equal((await call(ask(undefined, { headers: { 'x-connect-reports-secret': SECRET + 'x' } }))).status, 401);
  assert.equal((await call(ask(undefined, { headers: { 'x-connect-link-secret': SECRET } }))).status, 401, 'the link secret header is not this one');
  assert.equal((await call(ask(), { SUPABASE_SERVICE_ROLE_KEY: '' })).status, 503);
  assert.equal(calls.length, 0, 'nothing is read before the gate passes');

  // The selection must be one league and 1 to 100 distinct, plain ids.
  for (const query of ['', `leagueId=${L}`, `gameIds=g2final`, `leagueId=a.b&gameIds=g2final`, `leagueId=${L}&gameIds=`,
    `leagueId=${L}&gameIds=g2final,g2final`, `leagueId=${L}&gameIds=g2,%22x%22`, `leagueId=${L}&gameIds=${Array.from({ length: 101 }, (_, i) => `g${i}`).join(',')}`]) {
    const response = await call(ask(query));
    assert.equal(response.status, 400, `refused: ${query}`);
    assert.deepEqual(await body(response), { error: 'Choose one league and between 1 and 100 games.' });
  }
  assert.equal(calls.length, 0);

  // A good read: final games of this league that were asked for, their events, and the players they name.
  const ok = await call(ask());
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const read = await body(ok);
  assert.deepEqual(read, {
    leagueId: L,
    games: [
      { id: 'cg_11111111-1111-4111-8111-111111111111', league_id: L, home_team_id: 'th', away_team_id: 'ta', status: 'final', default_winner_team_id: null },
      { id: 'g2final', league_id: L, home_team_id: 'th', away_team_id: 'ta', status: 'final', default_winner_team_id: null },
    ],
    events: [
      { id: 'e1', league_id: L, game_id: 'cg_11111111-1111-4111-8111-111111111111', team_id: 'th', player_id: 'p1', type: 'fg2_make' },
      { id: 'e2', league_id: L, game_id: 'cg_11111111-1111-4111-8111-111111111111', team_id: 'ta', player_id: null, type: 'ft_make' },
      { id: 'e3', league_id: L, game_id: 'g2final', team_id: 'ta', player_id: 'p2', type: 'fg3_make' },
    ],
    players: [{ id: 'p1', league_id: L, name: 'Māia Te Aroha' }, { id: 'p2', league_id: L, name: 'Rua Parata' }],
    readAt: '2026-10-07T01:00:00.000Z',
  });
  assert.ok(calls.every(c => c.options.method === 'GET' && !c.options.body), 'only GETs leave the handler');
  assert.ok(calls.every(c => c.url.origin === BASE && c.options.headers.authorization === 'Bearer service-role-test-value'));
  assert.deepEqual(calls.map(c => c.url.pathname), ['/rest/v1/games', '/rest/v1/events', '/rest/v1/players']);
  assert.equal(calls[0].url.searchParams.get('status'), 'eq.final');
  assert.equal(calls[0].url.searchParams.get('league_id'), `eq.${L}`);
  assert.ok(!calls[2].url.searchParams.get('select').includes('number'), 'only the columns Reports uses');

  // No final game among those asked for: an empty read, without touching events or players.
  calls = [];
  const none = await body(await call(ask(`leagueId=${L}&gameIds=g3live,g4other`)));
  assert.deepEqual([none.games, none.events, none.players], [[], [], []]);
  assert.deepEqual(calls.map(c => c.url.pathname), ['/rest/v1/games']);

  // Events and players are read in full across pages, and player ids in chunks.
  const many = Array.from({ length: 1201 }, (_, i) => ({
    id: `m${String(i).padStart(5, '0')}`, league_id: L, game_id: 'g2final', team_id: 'ta', player_id: `q${i % 250}`, type: 'fg2_make',
  }));
  const roster = Array.from({ length: 250 }, (_, i) => ({ id: `q${i}`, league_id: L, name: `Player ${i}` }));
  const saved = { events: data.events, players: data.players };
  data.events = many; data.players = roster; calls = [];
  const big = await body(await call(ask(`leagueId=${L}&gameIds=g2final`)));
  assert.equal(big.events.length, 1201);
  assert.equal(big.players.length, 250);
  assert.equal(calls.filter(c => c.url.pathname === '/rest/v1/events').length, 3, 'three pages of 500');
  assert.ok(calls.filter(c => c.url.pathname === '/rest/v1/players').every(c => c.url.searchParams.get('id').split(',').length <= 100));
  Object.assign(data, saved);

  // Bounded: more than 20,000 events is refused before the rest is read.
  data.events = Array.from({ length: 20001 }, (_, i) => ({ id: `n${i}`, league_id: L, game_id: 'g2final', team_id: 'ta', player_id: null, type: 'tov' }));
  calls = [];
  const tooMany = await call(ask(`leagueId=${L}&gameIds=g2final`));
  assert.equal(tooMany.status, 413);
  assert.equal(calls.filter(c => c.url.pathname === '/rest/v1/events').length, 1);
  Object.assign(data, saved);

  // Upstream trouble and records Connect could not use are refused, never passed on half-read.
  for (const [problem, expected] of [
    [{ table: 'games', status: 500 }, 'Could not read the mobile records.'],
    [{ table: 'events', network: true }, 'Could not read the mobile records.'],
    [{ table: 'events', rows: [...data.events, { id: 'bad id', league_id: L, game_id: 'g2final', team_id: 'ta', player_id: null, type: 'tov' }] }, 'A mobile record could not be read for Reports.'],
    [{ table: 'players', rows: [{ id: 'p1', league_id: L, name: 'x'.repeat(201) }] }, 'A mobile record could not be read for Reports.'],
  ]) {
    fail = problem;
    const response = await call(ask());
    assert.equal(response.status, 502, JSON.stringify(problem));
    assert.deepEqual(await body(response), { error: expected });
  }
  fail = { table: 'events', shift: true };
  data.events = many;
  const shifted = await call(ask(`leagueId=${L}&gameIds=g2final`));
  assert.equal(shifted.status, 502, 'a total that changes between pages is a refused read');
  Object.assign(data, saved);
  fail = null;

  console.log('✓ Connect reports reader: GET-only secret gate, one league, final games only, referenced players, complete pagination, 20,000-event bound, refused partial reads');
})().catch(error => { console.error(error); process.exitCode = 1; });
