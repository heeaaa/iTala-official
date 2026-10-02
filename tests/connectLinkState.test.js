'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const baseline = process.argv.includes('--baseline');
const source = baseline ? require('node:child_process').execFileSync('git',
  ['show', '80bb143:src/sync/connectSchedule.ts'], { encoding: 'utf8' })
  : fs.readFileSync('src/sync/connectSchedule.ts', 'utf8');

let requests = 0;
let reply = { events: [], revision: 1, checkedAt: Date.now() };
let offline = true;
let legacy = false;
const exports_ = {};
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText, { exports: exports_, require: name => {
  assert.equal(name, './supabase');
  return { SYNC_ENABLED: true, getSupabase: () => ({ functions: { invoke: async (_, options) => {
    requests++;
    if (legacy) return options.body.action === 'refreshLinks'
      ? { error: { context: Response.json({ error: 'Choose an event.' }, { status: 400 }) }, data: null }
      : { error: null, data: { events: [{ id: 'legacy-event' }] } };
    return offline ? { error: Error('Service unavailable'), data: null } : { error: null, data: reply };
  } } }) };
}, AbortController, setTimeout, clearTimeout, Date, Intl, Map, Promise, Response });

(async () => {
  const { canStartFreeformGame, refreshConnectLinkState } = exports_;
  const league = { id: 'ordinary', kind: 'league', connectLink: { events: [], revision: 1, checkedAt: 1 } };
  for (let n = 0; n < 12; n++) {
    assert.equal(await canStartFreeformGame(league), true, 'an unlinked league starts even when Connect is unavailable');
  }
  assert.equal(requests, 0, 'Start Game, lineups, Tip Off and default must never discover Connect links');
  assert.equal(await canStartFreeformGame({ id: 'legacy', kind: 'league' }), true, 'legacy discovery is separate from starting games');
  assert.equal(await canStartFreeformGame({ ...league, connectLink: { ...league.connectLink, events: [{ id: 'event' }] } }), false);
  assert.equal(await canStartFreeformGame({ ...league, kind: 'recreational', connectLink: { events: [{ id: 'event' }] } }), true);
  assert.equal(await canStartFreeformGame({ ...league, connectLink: { events: [{ id: 'event' }] } }, false), true);
  offline = false;
  const [first, second] = await Promise.all([refreshConnectLinkState('ordinary'), refreshConnectLinkState('ordinary')]);
  assert.equal(first.revision, 1); assert.equal(second.revision, 1);
  assert.equal(requests, 1, 'simultaneous settings/tab checks share a request');
  await refreshConnectLinkState('ordinary');
  assert.equal(requests, 1, 'repeated visits are throttled');
  reply = { events: [{ id: 'event' }], revision: 2, checkedAt: Date.now() };
  assert.equal((await refreshConnectLinkState('ordinary', true)).revision, 2);
  assert.equal(requests, 2, 'explicit refresh bypasses throttling');
  offline = true;
  await assert.rejects(() => refreshConnectLinkState('ordinary', true));
  await assert.rejects(() => refreshConnectLinkState('ordinary'));
  assert.equal(requests, 3, 'failed discovery is throttled too');
  assert.equal(canStartFreeformGame({ ...league, connectLink: first }), true, 'failed checks cannot block regular games');
  assert.equal(canStartFreeformGame({ ...league, connectLink: { ...reply } }), false, 'failed checks cannot turn off a known link');
  legacy = true;
  const oldBackend = await refreshConnectLinkState('legacy-backend', true);
  assert.equal(oldBackend.revision, 0, 'legacy discovery never invents a server revision');
  assert.equal(oldBackend.events[0].id, 'legacy-event');
  assert.equal(canStartFreeformGame({ ...league, connectLink: oldBackend }), false,
    'a linked schedule remains available during the backend upgrade');
  console.log('✓ Connect link policy: zero game-start requests, unknown/local/rec modes, deduplicated discovery, explicit refresh and failure throttling');
})().catch(error => {
  if (baseline && requests > 0) console.error('BASELINE: an ordinary game attempted Connect discovery and failed while Connect was unavailable.');
  console.error(error); process.exitCode = 1;
});
