const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const { PostgrestClient } = require('@supabase/postgrest-js');
const React = require('./harness/pkg/react-live');
const ROOT = path.join(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const revision = 'f0a96c1'; // Merge of PR #34, before the report fix.
function read(file) {
  return baseline && /contentReports.ts|ReportContentScreen.tsx/.test(file)
    ? execFileSync('git', ['show', `${revision}:${file}`], { cwd: ROOT, encoding: 'utf8' })
    : fs.readFileSync(path.join(ROOT, file), 'utf8');
}
function load(file, imports, clock) {
  const context = {
    exports: {}, Error, TypeError, AbortController, Promise,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    require: name => { if (!(name in imports)) throw new Error(`Missing import ${name}`); return imports[name]; },
  };
  vm.runInNewContext(ts.transpileModule(read(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
    fileName: file,
  }).outputText, context);
  return context.exports;
}
function setup(outcomes, session = {}, guestOutcomes = []) {
  let callback;
  const timers = new Map();
  let next = 0;
  const clock = {
    setTimeout(cb, ms) { const id = ++next; timers.set(id, { cb, ms }); if (ms < 10_000) queueMicrotask(() => { timers.delete(id); cb(); }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const requests = [];
  let guestCalls = 0;
  const db = new PostgrestClient('https://report-test.invalid/rest/v1', {
    fetch: async (url, options) => {
      requests.push(JSON.parse(options.body));
      const next = outcomes.shift();
      if (next === 'hang') return new Promise(() => {}); // native transport ignores abort
      if (next instanceof Error) throw next;
      return new Response(JSON.stringify(next?.body ?? { reference: 'ITR-TEST', submitted_at: '2026-09-05' }), {
        status: next?.status ?? 200, headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  db.auth = {
    getSession: async () => ({ data: { session } }),
    signInAnonymously: async () => {
      guestCalls++;
      if (!guestOutcomes.length) return new Promise(() => {});
      const outcome = guestOutcomes.shift();
      if (outcome instanceof Error) throw outcome;
      session = { user: { id: 'guest', is_anonymous: true } };
      callback?.('SIGNED_IN', session);
      return { data: { session, user: session.user }, error: null };
    },
    onAuthStateChange(cb) { callback = cb; return { data: { subscription: { unsubscribe() {} } } }; },
  };
  const errors = load('src/store/authErrors.ts', {}, clock);
  const guest = load('src/store/guestSession.ts', {}, clock);
  const lib = load('src/lib/contentReports.ts', {
    '../sync/supabase': { getSupabase: () => db, SYNC_ENABLED: true },
    '../store/authErrors': errors,
    '../store/guestSession': guest,
  }, clock);
  let ids = 0;
  const screen = load('src/screens/ReportContentScreen.tsx', {
    react: React,
    'react-native': { Pressable: 'Pressable', TextInput: 'TextInput', View: 'View' },
    '../components/ui': Object.fromEntries(['Button', 'Card', 'Field', 'Screen', 'Txt'].map(k => [k, k])),
    '../lib/contentReports': lib,
    '../lib/format': { uid: () => `request-${++ids}` },
    '../theme': { colors: {}, radius: {}, space: n => n },
  }, clock).default;
  const root = React.render(screen, {
    route: { params: { recordType: 'league', recordId: 'l1', leagueId: 'l1', label: 'Test League' } },
    navigation: { goBack() {} },
  });
  function nodes(node = root.flush()) {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(n => nodes(n));
    return [node, ...nodes(node.props?.children ?? null)];
  }
  return {
    root, lib, requests, timers,
    guestCalls: () => guestCalls,
    startup: () => guest.ensureGuestSession(db),
    ready() { callback('SIGNED_IN', {}); },
    expire(ms) { for (const t of [...timers.values()]) if (t.ms === ms) t.cb(); },
    choose() { nodes().find(n => n.props.accessibilityRole === 'radio').props.onPress(); root.flush(); },
    click() { nodes().find(n => n.props.title === 'Submit report').props.onPress(); },
    text() { return nodes().filter(n => n.type === 'Txt').map(n => n.props.children).join(' '); },
    button() { return nodes().find(n => n.props.title === 'Submit report'); },
    edit() { nodes().find(n => n.type === 'TextInput').props.onChangeText('Updated explanation'); root.flush(); },
  };
}
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const failure = () => new TypeError('Network request failed');
const technical = /TypeError|Network request failed|PostgREST|PGRST|JWT|relation|stack|AbortError|undefined/i;
const watchdog = setTimeout(() => { console.error('FAIL: report test did not settle'); process.exit(1); }, 30_000);
(async () => {
  const h = setup([failure(), null]);
  h.choose(); h.click(); await flush();
  if (baseline) {
    assert.match(h.text(), /TypeError: Network request failed/);
    assert.equal(h.requests.length, 1);
    h.click(); await flush();
    assert.match(h.text(), /Report received/);
    console.log('PROVED PR #34: first click displays TypeError: Network request failed; second click succeeds.');
    return;
  }
  assert.match(h.text(), /Report received/);
  assert.doesNotMatch(h.text(), technical);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].p_request_id, h.requests[1].p_request_id);
  console.log('PASS: same failure through actual PostgREST + report screen succeeds on one click.');

  const boot = setup([null], null);
  boot.choose(); boot.click(); await flush();
  assert.equal(boot.requests.length, 0);
  boot.ready(); await flush();
  assert.match(boot.text(), /Report received/);

  const recovery = setup([null], null, [failure(), null]);
  await assert.rejects(recovery.startup(), /Network request failed/);
  recovery.choose(); recovery.click(); await flush();
  assert.match(recovery.text(), /Report received/);
  assert.equal(recovery.guestCalls(), 2, 'report can recover after failed boot');
  assert.equal(h.guestCalls(), 0, 'existing sessions do not create guests');

  const offline = setup([failure(), failure(), failure(), null]);
  offline.choose(); const tap = offline.button().props.onPress; tap(); tap(); await flush();
  assert.equal(offline.requests.length, 3, 'double tap does not start another submission');
  assert.match(offline.text(), /Check your connection/);
  assert.doesNotMatch(offline.text(), technical);
  assert.equal(offline.button().props.disabled, false);
  offline.click(); await flush();
  assert.match(offline.text(), /Report received/);
  assert.ok(offline.requests.every(r => r.p_request_id === offline.requests[0].p_request_id));

  for (const error of [
    { status: 400, body: { message: 'JWT expired', code: 'PGRST301' } },
    { status: 500, body: { message: 'relation public.content_reports does not exist' } },
    { status: 400, body: { message: 'TypeError: undefined is not a function' } },
    { body: {} },
  ]) {
    const bad = setup([error]);
    bad.choose(); bad.click(); await flush();
    assert.equal(bad.requests.length, 1);
    assert.match(bad.text(), /Please try again in a moment/);
    assert.doesNotMatch(bad.text(), technical);
  }
  const invalid = setup([{ status: 400, body: { message: 'Enter a valid contact email or leave it blank.' } }, null]);
  invalid.choose(); invalid.click(); await flush();
  assert.match(invalid.text(), /Enter a valid contact email/);
  invalid.edit(); invalid.click(); await flush();
  assert.notEqual(invalid.requests[0].p_request_id, invalid.requests[1].p_request_id);

  const hang = setup(['hang', null]);
  hang.choose(); hang.click(); await flush(); hang.expire(10_000); await flush();
  assert.match(hang.text(), /Report received/);
  assert.equal(hang.timers.size, 0);
  for (const value of [null, undefined, 'TypeError: Network request failed', new Error('secret SQL text'), { message: 'unknown stack' }]) {
    assert.doesNotMatch(h.lib.describeContentReportError(value), technical);
  }
  console.log('PASS: guest startup, double tap, offline/manual retry, changed form, safe errors, validation and ignored abort.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));

