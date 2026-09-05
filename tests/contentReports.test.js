const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/contentReports.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;

function harness(outcomes, session = {}) {
  let listener;
  let unsubscribed = 0;
  const calls = [];
  const timers = new Map();
  let nextTimer = 0;
  const sb = {
    auth: {
      getSession: async () => ({ data: { session } }),
      onAuthStateChange: cb => {
        listener = cb;
        return { data: { subscription: { unsubscribe: () => unsubscribed++ } } };
      },
    },
    rpc: (_name, args) => ({ abortSignal: signal => {
      calls.push(args);
      const outcome = outcomes.shift();
      if (outcome === 'timeout') return new Promise(resolve => {
        signal.addEventListener('abort', () => resolve({ error: { message: 'AbortError' } }));
      });
      if (outcome instanceof Error) return Promise.reject(outcome);
      return Promise.resolve(outcome);
    } }),
  };
  const context = {
    exports: {}, AbortController,
    setTimeout: (cb, ms) => { const id = ++nextTimer; timers.set(id, { cb, ms }); if (ms < 10_000) queueMicrotask(() => { timers.delete(id); cb(); }); return id; },
    clearTimeout: id => timers.delete(id),
    require: name => name.includes('guestSession') ? { ensureGuestSession: () => new Promise(() => {}) }
      : name.includes('supabase') ? { getSupabase: () => sb, SYNC_ENABLED: true }
      : { isNetworkFailure: msg => /network request failed|fetch failed/i.test(msg || '') },
  };
  vm.runInNewContext(source, context);
  return {
    submit: context.exports.submitContentReport, calls, timers,
    ready: () => listener('SIGNED_IN', {}),
    unsubscribed: () => unsubscribed,
    expire: ms => { for (const t of [...timers.values()]) if (t.ms === ms) t.cb(); },
  };
}
const input = { recordType: 'league', recordId: 'l1', leagueId: 'l1', reason: 'Incorrect information' };
const receipt = { data: { reference: 'ITR-test', submitted_at: '2026-09-05' }, error: null };
const network = { error: { message: 'TypeError: Network request failed' } };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

const watchdog = setTimeout(() => { console.error('FAIL: report test did not settle'); process.exit(1); }, 30_000);
(async () => {
  const boot = harness([receipt], null);
  const pending = boot.submit(input, 'boot');
  await flush();
  assert.equal(boot.calls.length, 0, 'wait for anonymous startup before writing');
  boot.ready();
  assert.equal((await pending).reference, 'ITR-test');
  assert.equal(boot.unsubscribed(), 1);
  assert.equal(boot.timers.size, 0);

  for (const failure of [network, new TypeError('Network request failed')]) {
    const h = harness([failure, receipt]);
    await h.submit(input, 'same-request');
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls.every(c => c.p_request_id === 'same-request'));
    assert.equal(h.timers.size, 0);
  }
  const offline = harness([network, network, network, receipt]);
  await assert.rejects(offline.submit(input, 'manual-retry'), /Check your connection/);
  assert.equal(offline.calls.length, 3);
  await offline.submit(input, 'manual-retry');
  assert.ok(offline.calls.every(c => c.p_request_id === 'manual-retry'));

  const validation = harness([{ error: { message: 'Enter a valid contact email or leave it blank.' } }]);
  await assert.rejects(validation.submit(input, 'invalid'), /valid contact email/);
  assert.equal(validation.calls.length, 1);

  const timeout = harness(['timeout', receipt]);
  const timed = timeout.submit(input, 'timeout');
  await flush();
  timeout.expire(10_000);
  await timed;
  assert.equal(timeout.calls.length, 2);
  assert.equal(timeout.timers.size, 0);

  const noSession = harness([], null);
  const missing = noSession.submit(input, 'missing');
  noSession.expire(12_000);
  await assert.rejects(missing, /still connecting/);
  assert.equal(noSession.calls.length, 0);
  assert.equal(noSession.unsubscribed(), 1);
  console.log('Content reporting: session startup, transport retries, timeout, manual retry and validation passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
