// Runs the actual provider, dialog and receipt client using the existing hook
// runtime. Native presentation and React scheduling still require device QA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const HookRuntime = require('./harness/pkg/react-live');

function load(file, imports) {
  const context = { exports: {}, Error, Promise, URLSearchParams, setTimeout, clearTimeout, process,
    require(name) { if (!(name in imports)) throw new Error(`Missing mock: ${name}`); return imports[name]; } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
    fileName: file,
  }).outputText, context);
  return context.exports;
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function nodes(element) {
  if (!element || typeof element !== 'object') return [];
  return [element, ...[element.props?.children].flat(Infinity).flatMap(nodes)];
}
function setup(options = {}) {
  const calls = [], disk = options.disk ?? new Map();
  const account = { id: 'account-a', email: 'a@example.invalid', is_anonymous: false };
  const guest = { id: 'guest', is_anonymous: true };
  let session = { user: options.restored ? account : guest };
  const storage = { getItem: async k => disk.get(k) ?? null, setItem: async (k, v) => { disk.set(k, v); },
    removeItem: async k => { disk.delete(k); } };
  const legal = load('src/lib/legal.ts', { '@react-native-async-storage/async-storage': { default: storage } });
  const receipt = { version: legal.LEGAL_VERSION, accepted_at: '2026-09-07T01:02:03.000Z' };
  if (options.cache) disk.set('itala.legal.receipt.v1.account-a', JSON.stringify(options.cache === true ? receipt : options.cache));
  const RN = { Platform: { OS: options.ios ? 'ios' : 'android' },
    StyleSheet: { create: v => v }, Linking: { openURL: async url => { calls.push(['link', url]); } },
    Modal: 'Modal', ScrollView: 'ScrollView', Text: 'Text', TouchableOpacity: 'TouchableOpacity', View: 'View' };
  const component = load('src/components/LegalAcknowledgement.tsx', { react: HookRuntime, 'react-native': RN,
    '../theme': { colors: {}, font: {}, radius: {}, space: n => n }, '../lib/legal': legal });
  const state = { status: options.status ?? { version: legal.LEGAL_VERSION, accepted_at: null }, save: receipt };
  const sb = {
    rpc: async (name, args) => {
      calls.push([name, args]);
      const value = name === 'legal_status' ? state.status : name === 'accept_legal' ? state.save : [];
      if (value instanceof Error) throw value;
      const result = await value;
      return result?.error ? result : { data: result, error: null };
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { is_admin: false } }) }) }) }),
    auth: {
      getSession: async () => ({ data: { session } }), getUser: async () => ({ data: { user: session.user } }),
      signInWithOAuth: async () => { calls.push(['google']); return { data: { url: 'https://provider.invalid' } }; },
      exchangeCodeForSession: async () => { session = { user: account }; return { data: { session } }; },
      signInWithIdToken: async () => { session = { user: account }; return { data: { session } }; },
      signOut: async () => { calls.push(['signOut']); session = null; return { error: null }; },
      signInAnonymously: async () => { session = { user: guest }; return { data: { session, user: guest } }; },
    },
  };
  const provider = load('src/store/AdminProvider.tsx', {
    react: HookRuntime, 'react-native': RN,
    'expo-web-browser': { maybeCompleteAuthSession() {}, openAuthSessionAsync: async () => options.cancelProvider
      ? { type: 'cancel' } : { type: 'success', url: 'itala://auth-callback?code=code' } },
    'expo-linking': { createURL: () => 'itala://auth-callback', parse: () => ({ queryParams: { code: 'code' } }) },
    'expo-apple-authentication': { isAvailableAsync: async () => true, AppleAuthenticationScope: { FULL_NAME: 'full-name', EMAIL: 'email' },
      signInAsync: async args => {
        calls.push(['apple', args]);
        if (options.cancelProvider) throw Object.assign(new Error('cancelled'), { code: 'ERR_REQUEST_CANCELED' });
        return { identityToken: 'test-token' };
      } },
    '../sync/supabase': { SYNC_ENABLED: true, getSupabase: () => sb },
    './guestSession': load('src/store/guestSession.ts', {}), '../lib/log': { devLog() {}, warn() {} },
    '../components/LegalAcknowledgement': component, '../lib/legal': legal,
    './authErrors': load('src/store/authErrors.ts', {}),
  });
  const root = HookRuntime.render(provider.AdminProvider, { children: null });
  const p = {
    root, calls, state, receipt, legal, disk, component,
    get ctx() { return root.element.props.value; },
    get dialog() { return nodes(root.element).find(n => n.type === component.LegalAcknowledgement).props; },
    async settle() { for (let i = 0; i < 35; i++) { await new Promise(r => setImmediate(r)); root.flush(); } },
    async submit() { p.dialog.onContinue(); await p.settle(); },
    async dismiss() { p.dialog.onDismiss(); await p.settle(); },
    count(name) { return calls.filter(c => c[0] === name).length; },
  };
  return p;
}

const cases = [];
function test(name, fn) { cases.push([name, fn]); }
test('unchecked dialog blocks continuation, check enables it, busy and new prompts reset safely', async () => {
  const p = setup(); await p.settle(); let continued = 0;
  const root = HookRuntime.render(p.component.LegalAcknowledgement, { prompt: { version: p.receipt.version, returning: false, busy: false },
    onContinue: () => continued++, onCancel() {}, onDismiss() {} });
  const checkbox = () => nodes(root.element).find(n => n.props?.accessibilityRole === 'checkbox');
  const agree = () => nodes(root.element).find(n => n.props?.accessibilityRole === 'button');
  assert.equal(agree().props.disabled, true); agree().props.onPress(); assert.equal(continued, 0);
  checkbox().props.onPress(); root.flush(); agree().props.onPress(); assert.equal(continued, 1);
  root.props.prompt = { ...root.props.prompt, busy: true }; root.invalidate(); root.flush();
  agree().props.onPress(); assert.equal(continued, 1); assert.equal(checkbox().props.disabled, true);
  root.props.prompt = null; root.invalidate(); root.flush();
  root.props.prompt = { version: p.receipt.version, returning: false, busy: false }; root.invalidate(); root.flush();
  assert.equal(checkbox().props.accessibilityState.checked, false);
  const links = HookRuntime.render(p.component.LegalLinks, {});
  for (const n of nodes(links.element).filter(n => n.props?.accessibilityRole === 'link')) n.props.onPress();
  assert.deepEqual(p.calls.filter(c => c[0] === 'link').map(c => c[1]), Array.from(p.legal.LEGAL_LINKS, l => l.url));
  const inline = HookRuntime.render(p.component.LegalLinks, { inline: true });
  const inlineNodes = nodes(inline.element);
  assert.equal(inlineNodes.flatMap(n => [n.props?.children].flat(Infinity)
    .filter(child => typeof child === 'string')).join(''), p.legal.LEGAL_STATEMENT,
  'inline presentation preserves the exact agreement wording');
  const inlineLinks = inlineNodes.filter(n => n.props?.accessibilityRole === 'link');
  assert.equal(inlineLinks.length, 3);
  for (const n of inlineLinks) n.props.onPress();
  assert.deepEqual(p.calls.filter(c => c[0] === 'link').slice(-3).map(c => c[1]),
    [p.legal.LEGAL_LINKS[0].url, p.legal.LEGAL_LINKS[2].url, p.legal.LEGAL_LINKS[1].url]);
  assert.equal(checkbox().props.accessibilityState.checked, false);
  root.unmount(); links.unmount(); inline.unmount(); p.root.unmount();
});
for (const provider of ['Google', 'Apple']) {
  test(`${provider}: cancelling the provider never opens review or records acceptance`, async () => {
    const p = setup({ cancelProvider: true }); await p.settle();
    assert.equal(await p.ctx[`signInWith${provider}`](), null); await p.settle();
    assert.equal(p.dialog.prompt, null); assert.equal(p.ctx.role, 'guest');
    assert.equal(p.ctx.authBusy, false); assert.equal(p.count('legal_status'), 0);
    assert.equal(p.count('accept_legal'), 0); p.root.unmount();
  });
  test(`${provider}: authenticate before review; declining signs out and duplicate calls are ignored`, async () => {
    const p = setup(); await p.settle(); const result = p.ctx[`signInWith${provider}`](); await p.settle();
    assert.equal(p.count(provider.toLowerCase()), 1); assert.equal(p.dialog.prompt.returning, false);
    assert.equal(p.count('accept_legal'), 0);
    assert.equal(await p.ctx.signInWithGoogle(), null); assert.equal(await p.ctx.signInWithApple(), null);
    p.dialog.onCancel(); await p.settle(); assert.equal(await result, null);
    assert.equal(p.count('signOut'), 1); assert.equal(p.ctx.role, 'guest');
    assert.match(p.ctx.errorFor('signin'), /need to agree/);
    const retry = p.ctx[`signInWith${provider}`](); await p.settle();
    assert.ok(p.dialog.prompt, 'declining does not create a receipt; next sign-in asks again');
    p.dialog.onCancel(); await p.settle(); await retry; p.root.unmount();
  });
  test(`${provider}: previously accepted account signs in without a prompt or duplicate write`, async () => {
    const p = setup(); await p.settle(); p.state.status = p.receipt;
    assert.equal(await p.ctx[`signInWith${provider}`](), 'user'); await p.settle();
    assert.equal(p.dialog.prompt, null); assert.equal(p.count('accept_legal'), 0);
    assert.equal(p.count(provider.toLowerCase()), 1); p.root.unmount();
  });
  test(`${provider}: role and memberships wait for confirmed receipt; retry is single-flight`, async () => {
    const p = setup({ ios: true }); await p.settle(); const result = p.ctx[`signInWith${provider}`](); await p.settle();
    p.state.save = { error: { message: 'network request failed' } };
    assert.equal(p.count(provider.toLowerCase()), 1);
    assert.equal(p.count('accept_legal'), 0, 'authentication alone must not record agreement');
    await p.submit();
    if (provider === 'Apple') assert.equal(JSON.stringify(p.calls.find(c => c[0] === 'apple')[1].requestedScopes), JSON.stringify(['full-name', 'email']));
    assert.equal(p.ctx.role, 'guest'); assert.equal(p.count('sync_admin_role'), 0); assert.equal(p.count('my_memberships'), 0);
    assert.match(p.dialog.prompt.error, /save/);
    const saving = deferred(); p.state.save = saving.promise;
    p.dialog.onContinue(); p.dialog.onContinue(); await p.settle();
    assert.equal(p.count('accept_legal'), 2, 'only first failed save and one retry');
    assert.equal(p.ctx.role, 'guest'); assert.equal(p.dialog.prompt.busy, true);
    saving.resolve(p.receipt); await p.settle(); await p.dismiss();
    assert.equal(await result, 'user'); assert.equal(p.ctx.role, 'user'); assert.equal(p.count('my_memberships'), 1);
    assert.equal(p.disk.size, 1); p.root.unmount();
  });
}
test('current server receipt restores without prompting or writing a duplicate receipt', async () => {
  const p = setup({ restored: true }); p.state.status = p.receipt; await p.settle();
  assert.equal(p.ctx.role, 'user'); assert.equal(p.dialog.prompt, null); assert.equal(p.count('accept_legal'), 0); p.root.unmount();
});
test('missing receipt holds restored account as guest; declining signs out locally', async () => {
  const p = setup({ restored: true }); await p.settle();
  assert.equal(p.ctx.role, 'guest'); assert.equal(p.count('my_memberships'), 0); assert.equal(p.dialog.prompt.returning, true);
  p.dialog.onCancel(); await p.settle(); assert.equal(p.count('signOut'), 1); assert.equal(p.ctx.userId, 'guest'); p.root.unmount();
});
for (const transport of [new Error('offline'), { error: { message: 'Failed to fetch' } }]) {
  test(`server-confirmed cache permits offline restoration (${transport instanceof Error ? 'reject' : 'resolved error'})`, async () => {
    const p = setup({ restored: true, cache: true, status: transport }); await p.settle();
    assert.equal(p.ctx.role, 'user'); assert.equal(p.dialog.prompt, null); p.root.unmount();
  });
}
test('offline without receipt and another account cache both remain guest', async () => {
  const p = setup({ restored: true, status: new Error('offline') });
  p.disk.set('itala.legal.receipt.v1.someone-else', JSON.stringify(p.receipt)); await p.settle();
  assert.equal(p.ctx.role, 'guest'); assert.ok(p.dialog.prompt.error); p.root.unmount();
});
test('known newer server version overrides valid cache and blocks account access/save', async () => {
  const p = setup({ restored: true, cache: true, status: { version: 'new-version', accepted_at: null } }); await p.settle();
  assert.equal(p.ctx.role, 'guest'); assert.match(p.dialog.prompt.error, /update/);
  await p.submit(); assert.equal(p.count('accept_legal'), 0); assert.equal(p.ctx.role, 'guest'); p.root.unmount();
});
test('observing a newer release invalidates the receipt across an offline restart', async () => {
  const first = setup({ restored: true, cache: true, status: { version: 'new-release', accepted_at: null } }); await first.settle();
  assert.equal(first.ctx.role, 'guest'); first.root.unmount();
  const next = setup({ restored: true, disk: first.disk, status: new Error('offline') }); await next.settle();
  assert.equal(next.ctx.role, 'guest', 'known obsolete receipt must not reopen account on offline restart');
  assert.ok(next.dialog.prompt); next.root.unmount();
});
test('unmounting an open post-auth prompt never grants account access', async () => {
  const p = setup({ ios: true }); await p.settle(); const result = p.ctx.signInWithApple(); await p.settle();
  p.root.unmount(); assert.equal(await result, null); assert.equal(p.count('apple'), 1);
  assert.equal(p.count('accept_legal'), 0); assert.equal(p.count('sync_admin_role'), 0);
});
test('unmount while iOS legal modal is dismissing never publishes the account', async () => {
  const p = setup({ ios: true }); await p.settle(); const result = p.ctx.signInWithApple(); await p.settle();
  await p.submit(); assert.equal(p.count('apple'), 1); assert.equal(p.ctx.role, 'guest');
  p.root.unmount(); await p.settle(); assert.equal(await result, null);
  assert.equal(p.count('sync_admin_role'), 0, 'provider unmount must cancel an accepted but not yet dismissed review');
});
test('post-auth status rejection holds account access even with a cached receipt', async () => {
  const p = setup({ cache: true, status: { error: { message: 'offline' } } }); await p.settle();
  const result = p.ctx.signInWithGoogle(); await p.settle(); await p.submit();
  assert.equal(p.count('google'), 1); assert.match(p.dialog.prompt.error, /load/);
  assert.equal(p.ctx.role, 'guest'); assert.equal(p.count('accept_legal'), 0);
  p.dialog.onCancel(); await p.settle(); assert.equal(await result, null); p.root.unmount();
});
test('stale, malformed and unconfirmed local receipts are never accepted', async () => {
  for (const cache of [{ version: 'old', accepted_at: '2026-09-07' }, { version: '2026-09-04', accepted_at: null }, { version: '2026-09-04', accepted_at: 'bad-date' }]) {
    const p = setup({ restored: true, cache, status: new Error('offline') }); await p.settle();
    assert.equal(p.ctx.role, 'guest'); assert.ok(p.dialog.prompt); p.root.unmount();
  }
});
test('server receipt validation refuses missing date and wrong version; cache failure is optional', async () => {
  const p = setup(); await p.settle();
  for (const data of [{ version: p.receipt.version, accepted_at: null }, { ...p.receipt, version: 'other' }]) {
    await assert.rejects(p.legal.recordLegalAcceptance({ rpc: async () => ({ data }) }, p.receipt.version), /not confirmed/);
  }
  const legal = load('src/lib/legal.ts', { '@react-native-async-storage/async-storage': { default: { setItem: async () => { throw new Error('disk full'); } } } });
  await legal.cacheLegalReceipt('a', p.receipt); p.root.unmount();
});

(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`  PASS ${name}`); }
    catch (e) { failed++; console.error(`  FAIL ${name}\n${e.stack}`); }
  }
  console.log(`Legal: ${cases.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();

