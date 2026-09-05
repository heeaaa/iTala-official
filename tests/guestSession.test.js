const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const context = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/store/guestSession.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, context);
const { ensureGuestSession } = context.exports;
const watchdog = setTimeout(() => { console.error('FAIL: guest session test stalled'); process.exit(1); }, 5000);
(async () => {
  let creates = 0;
  let finish;
  const session = { user: { id: 'guest', is_anonymous: true } };
  const sb = { auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
    signInAnonymously: () => { creates++; return new Promise(resolve => { finish = resolve; }); },
  } };
  const boot = ensureGuestSession(sb);
  const report = ensureGuestSession(sb);
  assert.equal(boot, report);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(creates, 1);
  // A caller ending its wait must not permit another in-flight sign-in.
  assert.equal(ensureGuestSession(sb), boot);
  finish({ data: { session, user: session.user }, error: null });
  await boot;

  const account = { user: { id: 'account-owner', email: 'test@example.invalid', is_anonymous: false } };
  sb.auth.getSession = async () => ({ data: { session: account }, error: null });
  const restored = await ensureGuestSession(sb);
  assert.equal(restored.data.user.id, 'account-owner');
  assert.equal(creates, 1, 'existing account is never replaced');
  sb.auth.getSession = async () => ({ data: { session: null }, error: new Error('Network request failed') });
  await assert.rejects(ensureGuestSession(sb), /Network request failed/);
  assert.equal(creates, 1, 'an errored read is not a missing session');

  let answerRead;
  sb.auth.getSession = () => new Promise(resolve => { answerRead = resolve; });
  const stalled = ensureGuestSession(sb);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(creates, 1);
  assert.equal(ensureGuestSession(sb), stalled);
  answerRead({ data: { session: account }, error: null });
  assert.equal((await stalled).data.user.id, 'account-owner');

  sb.auth.getSession = async () => ({ data: { session: null }, error: null });
  sb.auth.signInAnonymously = async () => { creates++; throw new Error('Network request failed'); };
  await assert.rejects(ensureGuestSession(sb), /Network request failed/);
  sb.auth.signInAnonymously = async () => { creates++; return { data: { session, user: session.user }, error: null }; };
  assert.equal((await ensureGuestSession(sb)).data.user.id, 'guest');
  assert.equal(creates, 3, 'settled failure allows recovery');
  console.log('PASS: shared guest sign-in, in-flight retention, account preservation, failed/stalled reads and recovery.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
