'use strict';
// How the app talks to the connect-schedule bridge (`call` in
// src/sync/connectSchedule.ts), driven through the REAL installed supabase-js
// client with only `fetch` replaced, so every failure arrives in the exact shape
// the SDK produces on a phone (FunctionsFetchError, FunctionsHttpError,
// FunctionsRelayError) rather than in a shape a fake chose.
//
// The bug: Tip off sometimes showed "Could not load the Connect schedule. Check
// your connection and try again." on a working connection. Probing the deployed
// function on 07/10/2026 caught the cause: Supabase's Edge Runtime answered one
// request with 503 {"code":"SUPABASE_EDGE_RUNTIME_SERVICE_DEGRADED"} before any
// function code ran, and the next request two seconds later reached the handler.
// The client treated that answer as final. A request that gets no response at
// all (FunctionsFetchError) ended the same way.
//
//   node tests/connectInvoke.test.js             current source
//   node tests/connectInvoke.test.js --baseline  d43dd6c, before the fix: must fail
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { createClient } = require('@supabase/supabase-js');
const Hooks = require('./harness/pkg/react-live');

const baseline = process.argv.includes('--baseline');
const source = baseline
  ? require('node:child_process').execFileSync('git', ['show', 'd43dd6c:src/sync/connectSchedule.ts'], { encoding: 'utf8' })
  : fs.readFileSync('src/sync/connectSchedule.ts', 'utf8');

const EVENT = '11111111-1111-4111-8111-111111111111';
const FIXTURE = '22222222-2222-4222-8222-222222222222';
// Captured verbatim from the deployed function.
const DEGRADED = { code: 'SUPABASE_EDGE_RUNTIME_SERVICE_DEGRADED', message: 'Service is temporarily unavailable' };
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// The server, one scripted answer per request. Unscripted requests succeed.
const sent = [];
let script = [];
const answers = {
  degraded: () => json(DEGRADED, 503),
  offline: () => { throw new TypeError('Network request failed'); }, // React Native's wording
  relay: () => new Response('relay unavailable', { status: 502, headers: { 'x-relay-error': 'true' } }),
  notDeployed: () => json({ code: 'NOT_FOUND', message: 'Requested function was not found' }, 404),
  handlerRefusal: () => json({ error: 'This scheduled game is no longer available to start. Refresh the schedule.' }, 409),
  handlerUpstream: () => json({ error: 'Could not reach the schedule service.' }, 502),
  portal: () => new Response('<html>Sign in to Gym WiFi</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  hang: init => new Promise((_, reject) => init.signal.addEventListener('abort',
    () => reject(new DOMException('The operation was aborted.', 'AbortError')))),
  slowDegraded: () => new Promise(resolve => clock.setTimeout(() => resolve(json(DEGRADED, 503)), 14800)),
  // Headers arrive, the body never finishes.
  stalledBody: () => new Response(new ReadableStream({ start() {} }), { status: 503, headers: { 'content-type': 'application/json' } }),
};
async function fakeFetch(url, init) {
  const body = JSON.parse(init.body);
  sent.push({ url: String(url), body, auth: new Headers(init.headers).get('authorization') });
  const step = script.shift();
  if (step) return answers[step](init);
  if (body.action === 'startGame') return json({ game: { id: `cg_${body.gameId}`, status: 'live' } });
  if (body.action === 'recordDefault') return json({ game: { id: `cg_${body.gameId}`, status: 'final' } });
  if (body.action === 'listEvents') return json({ events: [{ id: EVENT, name: 'Event', timezone: 'Pacific/Auckland', divisions: [] }] });
  return json({ event: { id: EVENT, name: 'Event', timezone: 'Pacific/Auckland', courtNames: [] }, divisions: [], teams: [], games: [] });
}
const sb = createClient('https://bridge-test.invalid', 'anon-key', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: fakeFetch },
  // Node 20 (CI) has no global WebSocket and the realtime client insists on a
  // constructor. No channel is ever opened here, so an inert one is enough.
  realtime: { transport: class InertSocket {} },
});

// A clock the test advances by hand, so retry waits and the 15 s deadline are
// exact rather than raced against real time.
const clock = (() => {
  let now = 0, seq = 0;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { timers.set(++seq, { at: now + (ms || 0), fn }); return seq; },
    clearTimeout: id => { timers.delete(id); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = end;
      await settle();
    },
    pending: () => timers.size,
  };
})();
// Nothing here does real I/O, so a fixed number of event-loop turns is enough;
// the margin is generous so a slow CI runner cannot change the outcome.
async function settle() { for (let i = 0; i < 100; i++) await new Promise(resolve => setImmediate(resolve)); }

function load(file, imports, src = fs.readFileSync(file, 'utf8')) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText, { exports, require: name => { assert.ok(name in imports, name); return imports[name]; },
    AbortController, Date, Intl, Map, Promise, Response, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  return exports;
}
const connect = load('src/sync/connectSchedule.ts', { './supabase': { SYNC_ENABLED: true, getSupabase: () => sb } }, source);

async function outcome(promise) {
  try { return { value: await promise }; } catch (error) { return { error }; }
}
let checks = 0;
async function check(label, fn) {
  sent.length = 0; script = [];
  await fn();
  await clock.advance(60000); // anything still scheduled must not send more
  checks++;
  console.log(`PASS ${label}`);
}

(async () => {
  await check('a degraded Edge Runtime answer is retried and Tip off gets its game', async () => {
    script = ['degraded'];
    const result = outcome(connect.startConnectGame('league', EVENT, FIXTURE, ['h1'], ['a1']));
    await settle();
    await clock.advance(500);
    const { value, error } = await result;
    assert.equal(error?.message, undefined, 'the user saw an error on a working connection');
    assert.deepEqual(value, { id: `cg_${FIXTURE}`, status: 'live' });
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1].body, sent[0].body, 'the retry is the same idempotent request');
    assert.equal(sent[0].auth, 'Bearer anon-key', 'requests went through the real supabase-js auth wrapper');
  });

  await check('a request that got no response is retried', async () => {
    script = ['offline'];
    const result = outcome(connect.startConnectGame('league', EVENT, FIXTURE, ['h1'], ['a1']));
    await settle(); await clock.advance(500);
    assert.equal((await result).value?.id, `cg_${FIXTURE}`);
    assert.equal(sent.length, 2);
  });

  await check('a relay failure is retried', async () => {
    script = ['relay', 'degraded'];
    const result = outcome(connect.recordConnectDefaultGame('league', EVENT, FIXTURE, 'home', 20));
    await settle(); await clock.advance(500); await clock.advance(1000);
    assert.deepEqual((await result).value, { id: `cg_${FIXTURE}`, status: 'final' });
    assert.equal(sent.length, 3, 'waits 500 ms, then 1 s');
  });

  await check('the handler\'s own answer is final and shown as written', async () => {
    for (const [step, message, status] of [
      ['handlerRefusal', 'This scheduled game is no longer available to start. Refresh the schedule.', 409],
      ['handlerUpstream', 'Could not reach the schedule service.', 502],
    ]) {
      sent.length = 0; script = [step];
      const { error } = await outcome(connect.startConnectGame('league', EVENT, FIXTURE, ['h1'], ['a1']));
      assert.equal(error.message, message);
      assert.equal(error.status, status);
      assert.equal(sent.length, 1, 'a handler answer is not resent');
    }
  });

  await check('a lasting outage stops after three sends with a message about Tip off, not the schedule', async () => {
    script = ['degraded', 'degraded', 'degraded'];
    const result = outcome(connect.startConnectGame('league', EVENT, FIXTURE, ['h1'], ['a1']));
    await settle(); await clock.advance(500); await clock.advance(1000);
    const { error } = await result;
    assert.equal(error.message, 'Could not start this game. The schedule service is busy. Try again in a moment.');
    assert.equal(error.status, 503);
    assert.equal(sent.length, 3);
  });

  await check('no connection at all ends with connection advice for the action that failed', async () => {
    for (const [run, message] of [
      [() => connect.startConnectGame('league', EVENT, FIXTURE, ['h1'], ['a1']), 'Could not start this game. Check your connection and try again.'],
      [() => connect.recordConnectDefaultGame('league', EVENT, FIXTURE, 'home', 20), 'Could not save this default result. Check your connection and try again.'],
      [() => connect.getConnectSchedule('league', EVENT), 'Could not load the Connect schedule. Check your connection and try again.'],
    ]) {
      sent.length = 0; script = ['offline', 'offline', 'offline'];
      const result = outcome(run());
      await settle(); await clock.advance(500); await clock.advance(1000);
      assert.equal((await result).error.message, message);
      assert.equal(sent.length, 3);
    }
  });

  await check('a gateway refusal that is not an outage is not retried, and keeps its status', async () => {
    script = ['notDeployed'];
    const { error } = await outcome(connect.startConnectGame('league', EVENT, FIXTURE, ['h1'], ['a1']));
    assert.equal(error.message, 'Could not start this game. Check your connection and try again.');
    assert.equal(error.status, 404);
    assert.equal(sent.length, 1);
  });

  await check('one 15 s deadline covers every attempt, and nothing is sent after it', async () => {
    script = ['hang'];
    const hung = outcome(connect.startConnectGame('league', EVENT, FIXTURE, ['h1'], ['a1']));
    await settle(); await clock.advance(15000);
    assert.equal((await hung).error.message, 'Starting this game timed out. Check your connection and try again.');
    assert.equal(sent.length, 1);

    // The deadline passing during the wait before a retry: the retry is never sent.
    sent.length = 0; script = ['slowDegraded'];
    const late = outcome(connect.getConnectSchedule('league', EVENT));
    await settle(); await clock.advance(14800); // a 503 arrives at 14.8 s and a 500 ms wait begins
    assert.equal(sent.length, 1);
    await clock.advance(200);
    assert.equal((await late).error.message, 'Schedule request timed out. Check your connection and try again.');
    await clock.advance(5000);
    assert.equal(sent.length, 1, 'a retry was sent after the person was told it timed out');
    assert.equal(clock.pending(), 0, 'no timer is left running');
  });

  await check('an error body that never finishes cannot outlive the deadline', async () => {
    script = ['stalledBody'];
    const stalled = outcome(connect.recordConnectDefaultGame('league', EVENT, FIXTURE, 'home', 20));
    await settle(); await clock.advance(15000);
    assert.equal((await stalled).error.message, 'Saving this default result timed out. Check your connection and try again.');
    assert.equal(sent.length, 1);
  });

  await check('a 200 that is not the bridge\'s answer fails cleanly instead of crashing Tip off', async () => {
    script = ['portal'];
    const { error } = await outcome(connect.startConnectGame('league', EVENT, FIXTURE, ['h1'], ['a1']));
    assert.equal(error.message, 'Could not start this game. Check your connection and try again.');
  });

  await check('refreshLinks still falls back to the legacy lookup after a lasting 503', async () => {
    script = ['degraded', 'degraded', 'degraded'];
    const result = outcome(connect.refreshConnectLinkState('legacy-fallback', true));
    await settle(); await clock.advance(500); await clock.advance(1000);
    const { value, error } = await result;
    assert.equal(error, undefined);
    assert.equal(value.revision, 0, 'the legacy lookup supplies an unversioned hint');
    assert.deepEqual(sent.map(s => s.body.action), ['refreshLinks', 'refreshLinks', 'refreshLinks', 'listEvents']);
  });

  // The screen the bug was reported on, end to end: Tip off with a scheduled game.
  await check('Tip off on the lineup screen survives a degraded answer with no error shown', async () => {
    const theme = load('src/theme.ts', {});
    const format = load('src/lib/format.ts', {});
    const stats = load('src/lib/stats.ts', { './format': format, '../theme': theme });
    const league = { id: 'league', name: 'League', season: '2026', kind: 'league', detailLoaded: true, createdAt: 1,
      connectLink: { events: [{ id: EVENT, name: 'Event' }], revision: 2, checkedAt: 2 },
      teams: [{ id: 'home', name: 'Team D', color: '#FFC24B', playerIds: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] },
        { id: 'away', name: 'Team I', color: '#E23E57', playerIds: ['a1', 'a2', 'a3', 'a4', 'a5'] }],
      players: [...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'], ...['a1', 'a2', 'a3', 'a4', 'a5']].map(id => ({ id, name: id })),
      games: [], events: [] };
    const routes = [];
    let loads = 0;
    const Lineup = load('src/screens/SelectLineupScreen.tsx', {
      react: Hooks,
      'react-native': Object.fromEntries(['View', 'ScrollView', 'Pressable', 'ActivityIndicator'].map(name => [name, name])),
      '../components/ui': Object.fromEntries(['Screen', 'Txt', 'Card', 'Button', 'TeamBadge'].map(name => [name, name])),
      '../store/StoreProvider': { useLeague: () => league,
        useStore: () => ({ dispatch() {}, loadLeagueDetail: async () => { loads++; return true; } }) },
      '../theme': theme, '../sync/connectSchedule': connect, '../lib/stats': stats,
      '../components/DefaultResultModal': { default: 'DefaultResultModal' },
    }).default;
    const nodes = n => !n || typeof n !== 'object' ? [] : Array.isArray(n) ? n.flatMap(nodes) : [n, ...nodes(n.props?.children)];
    const text = root => nodes(root.element).filter(n => n.type === 'Txt').map(n => [].concat(n.props.children).join('')).join(' | ');
    const button = (root, title) => nodes(root.element).find(n => n.type === 'Button' && n.props.title === title);
    const navigation = { replace: (...args) => routes.push(args), navigate: (...args) => routes.push(args) };
    const params = { leagueId: 'league', gameId: 'pending-start',
      pending: { homeTeamId: 'home', awayTeamId: 'away', connect: { eventId: EVENT, gameId: FIXTURE } } };

    script = ['degraded'];
    let root = Hooks.render(Lineup, { route: { params }, navigation });
    button(root, 'Tip off  ▶').props.onPress();
    await settle(); root.flush();
    assert.equal(button(root, 'Starting…').props.disabled, true, 'Tip off is locked while the retry runs');
    await clock.advance(500); root.flush();
    // Compared as JSON: the screen builds this object inside the VM's realm.
    assert.equal(JSON.stringify(routes.at(-1)),
      JSON.stringify(['LiveGame', { leagueId: 'league', gameId: `cg_${FIXTURE}`, spectator: false }]));
    assert.equal(loads, 1);
    assert.ok(!/Could not|Check your connection/.test(text(root)), `error shown: ${text(root)}`);
    assert.deepEqual(sent[0].body.homeOnCourt, ['h1', 'h2', 'h3', 'h4', 'h5']);
    root.unmount();

    // When it really cannot get through, the message says what failed and Tip off works again.
    sent.length = 0; routes.length = 0; script = ['degraded', 'degraded', 'degraded'];
    root = Hooks.render(Lineup, { route: { params }, navigation });
    button(root, 'Tip off  ▶').props.onPress();
    await settle(); await clock.advance(500); await clock.advance(1000); root.flush();
    assert.equal(routes.length, 0);
    assert.match(text(root), /Could not start this game\. The schedule service is busy\. Try again in a moment\./);
    assert.equal(button(root, 'Tip off  ▶').props.disabled, false);
    root.unmount();
  });

  console.log(`✓ Connect bridge transport: ${checks} checks - degraded/relay/no-response retried with one deadline, handler answers final, action-specific messages, Tip off end to end`);
})().catch(error => {
  if (baseline) console.error('BASELINE (before the fix) reproduced the bug:', error.message);
  console.error(error);
  process.exitCode = 1;
});
