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
// The device also keeps the version the server last required, beside the receipts.
const REQUIRED = 'itala.legal.required.v1';
const receiptKeys = disk => [...disk.keys()].filter(k => k.startsWith('itala.legal.receipt.'));
function nodes(element) {
  if (!element || typeof element !== 'object') return [];
  return [element, ...[element.props?.children].flat(Infinity).flatMap(nodes)];
}
function setup(options = {}) {
  const calls = [], disk = options.disk ?? new Map();
  const account = { id: 'account-a', email: 'a@example.invalid', is_anonymous: false };
  const guest = { id: 'guest', is_anonymous: true };
  let session = { user: options.restored ? account : guest };
  const storage = { getItem: async k => disk.get(k) ?? null,
    setItem: async (k, v) => { if (options.failRequired && k === REQUIRED) throw new Error('storage unavailable'); disk.set(k, v); },
    removeItem: async k => { if (options.failRemove) throw new Error('storage unavailable'); disk.delete(k); } };
  const legal = load('src/lib/legal.ts', { '@react-native-async-storage/async-storage': { default: storage } });
  const receipt = { version: legal.LEGAL_VERSION, accepted_at: '2026-09-07T01:02:03.000Z' };
  if (options.cache) disk.set('itala.legal.receipt.v1.account-a', JSON.stringify(options.cache === true ? receipt : options.cache));
  const RN = { Platform: { OS: options.ios ? 'ios' : 'android' },
    StyleSheet: { create: v => v }, Linking: { openURL: async url => { calls.push(['link', url]); } },
    AccessibilityInfo: { announceForAccessibility: message => { calls.push(['announce', message]); } },
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
    './rosterDraft': { clearAccountRosterDrafts: async () => {} },
    '../sync/recSetup': { clearRecSetup: async () => {} },
    // Account deletion now routes Apple-linked accounts through a revoking Edge
    // Function. This suite is about the legal receipt, so the real module is
    // loaded (rather than stubbed) and its behaviour is asserted next door, in
    // tests/appleRevocation.test.js.
    '../lib/appleAccountDeletion': load('src/lib/appleAccountDeletion.ts', {
      'react-native': RN,
      'expo-apple-authentication': { signInAsync: async () => ({ authorizationCode: 'legal-suite-code' }) },
      '../store/authErrors': load('src/store/authErrors.ts', {}),
    }),
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
  const compact = HookRuntime.render(p.component.LegalLinks, { compact: true });
  const compactLinks = nodes(compact.element).filter(n => n.props?.accessibilityRole === 'link');
  assert.equal(compactLinks.length, 3, 'compact Settings rows retain all legal links');
  assert.deepEqual(compactLinks.map(n => n.props.accessibilityLabel), Array.from(p.legal.LEGAL_LINKS, l => l.label));
  for (const n of compactLinks) n.props.onPress();
  assert.deepEqual(p.calls.filter(c => c[0] === 'link').slice(-3).map(c => c[1]), Array.from(p.legal.LEGAL_LINKS, l => l.url));
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
  root.unmount(); links.unmount(); compact.unmount(); inline.unmount(); p.root.unmount();
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
    assert.equal(receiptKeys(p.disk).length, 1); p.root.unmount();
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
  for (const cache of [{ version: 'old', accepted_at: '2026-09-07' }, { version: '2026-10-02', accepted_at: null }, { version: '2026-10-02', accepted_at: 'bad-date' }]) {
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

// A build ships while the server still requires the bundle before its own:
// docs/LEGAL_ACKNOWLEDGEMENT.md promotes only once the build is available, and
// App Review signs in before that. Treating that server as "update iTala" signed
// every account out of a build that was already the newest one.
const ARCHIVED = ['terms', 'privacy', 'content-policy'].map(doc => `https://www.itala.fyi/archive/2026-09-07/${doc}/`);
const earlier = (acceptedAt = '2026-09-07T01:02:03.000Z') => ({ version: '2026-09-07', accepted_at: acceptedAt });
const accepted = p => p.calls.filter(c => c[0] === 'accept_legal').map(c => c[1].p_version);
const cachedVersion = p => JSON.parse(p.disk.get('itala.legal.receipt.v1.account-a') ?? 'null')?.version;
test('the build knows exactly its own bundle and the one before it', async () => {
  const legal = load('src/lib/legal.ts', { '@react-native-async-storage/async-storage': { default: {} } });
  assert.equal(legal.PREVIOUS_LEGAL_VERSION, '2026-09-07');
  assert.equal(legal.legalLinksFor(legal.LEGAL_VERSION), legal.LEGAL_LINKS);
  assert.deepEqual(Array.from(legal.legalLinksFor('2026-09-07'), link => link.url), ARCHIVED,
    'the earlier bundle opens the archived text its receipts cite');
  assert.equal(legal.PRIVACY_POLICY_URL, legal.LEGAL_LINKS.find(link => link.label === 'Privacy Policy').url,
    'About opens the current Privacy Policy, not whichever link is listed second');
  for (const version of ['2026-09-06', 'constructor', '__proto__', 'hasOwnProperty']) {
    await assert.rejects(legal.readLegalStatus({ rpc: async () => ({ data: { version, accepted_at: null } }) }),
      error => error instanceof legal.LegalVersionError, `${version} is not a bundle this build can show`);
  }
});
test('server still on the previous bundle: an account that accepted it restores, caches it and restores offline', async () => {
  const p = setup({ restored: true, status: earlier() }); await p.settle();
  assert.equal(p.ctx.role, 'user'); assert.equal(p.dialog.prompt, null); assert.equal(p.count('accept_legal'), 0);
  assert.equal(cachedVersion(p), '2026-09-07'); assert.equal(p.disk.get(REQUIRED), '2026-09-07'); p.root.unmount();
  const next = setup({ restored: true, disk: p.disk, status: new Error('offline') }); await next.settle();
  assert.equal(next.ctx.role, 'user', 'the receipt matches the bundle the device last saw required'); next.root.unmount();
});
test('server still on the previous bundle: sign-in asks for it, opens its archived text and records it', async () => {
  const p = setup(); await p.settle(); p.state.status = earlier(null); p.state.save = earlier('2026-10-05T01:02:03.000Z');
  const result = p.ctx.signInWithGoogle(); await p.settle();
  assert.equal(p.dialog.prompt.version, '2026-09-07'); assert.equal(p.dialog.prompt.error, null, 'no update message');
  const dialog = HookRuntime.render(p.component.LegalAcknowledgement, { prompt: p.dialog.prompt, onContinue() {}, onCancel() {}, onDismiss() {} });
  assert.equal(nodes(dialog.element).find(n => n.type === p.component.LegalLinks).props.version, '2026-09-07',
    'the prompt opens the documents of the bundle it records');
  const inline = HookRuntime.render(p.component.LegalLinks, { inline: true, version: '2026-09-07' });
  for (const n of nodes(inline.element).filter(n => n.props?.accessibilityRole === 'link')) n.props.onPress();
  assert.deepEqual(p.calls.filter(c => c[0] === 'link').map(c => c[1]).sort(), [...ARCHIVED].sort());
  dialog.unmount(); inline.unmount();
  await p.submit();
  assert.deepEqual(accepted(p), ['2026-09-07']); assert.equal(p.dialog.prompt, null);
  assert.equal(await result, 'user'); assert.equal(p.ctx.role, 'user'); assert.equal(cachedVersion(p), '2026-09-07');
  p.root.unmount();
});
for (const transport of [new Error('offline'), { error: { message: 'Failed to fetch' } }]) {
  test(`an upgraded account restores offline from its previous-bundle receipt (${transport instanceof Error ? 'reject' : 'resolved error'})`, async () => {
    const p = setup({ restored: true, cache: earlier(), status: transport }); await p.settle();
    assert.equal(p.ctx.role, 'user'); assert.equal(p.dialog.prompt, null); p.root.unmount();
  });
}
test('after promotion an earlier receipt asks for the new bundle and cannot reopen the account offline', async () => {
  const first = setup({ restored: true, cache: earlier() }); await first.settle();
  assert.equal(first.ctx.role, 'guest'); assert.equal(first.dialog.prompt.version, first.legal.LEGAL_VERSION);
  assert.equal(first.dialog.prompt.error, null, 'the newest build is not told to update');
  assert.equal(cachedVersion(first), undefined, 'the server has no receipt for its bundle, so the cache goes');
  first.root.unmount();
  const next = setup({ restored: true, disk: first.disk, status: new Error('offline') }); await next.settle();
  assert.equal(next.ctx.role, 'guest'); assert.ok(next.dialog.prompt); next.root.unmount();
});
test('a promotion while the prompt is open shows the new bundle before anything is recorded', async () => {
  const p = setup(); await p.settle(); p.state.status = earlier(null);
  const result = p.ctx.signInWithApple(); await p.settle();
  assert.equal(p.dialog.prompt.version, '2026-09-07');
  p.state.status = { version: p.legal.LEGAL_VERSION, accepted_at: null };
  await p.submit();
  assert.equal(p.count('accept_legal'), 0, 'agreement to the earlier documents is not recorded against the new ones');
  assert.equal(p.dialog.prompt.version, p.legal.LEGAL_VERSION); assert.match(p.dialog.prompt.error, /changed/);
  assert.equal(p.dialog.prompt.busy, false); assert.equal(p.ctx.role, 'guest');
  await p.submit();
  assert.deepEqual(accepted(p), [p.legal.LEGAL_VERSION]); assert.equal(p.dialog.prompt, null);
  assert.equal(await result, 'user'); p.root.unmount();
});
test('a prompt opened without reaching the server shows the required bundle before recording', async () => {
  const p = setup(); await p.settle(); p.state.status = { error: { message: 'Failed to fetch' } };
  const result = p.ctx.signInWithGoogle(); await p.settle();
  assert.equal(p.dialog.prompt.version, p.legal.LEGAL_VERSION); assert.match(p.dialog.prompt.error, /load/);
  p.state.status = earlier(null); p.state.save = earlier('2026-10-05T01:02:03.000Z');
  await p.submit();
  assert.equal(p.count('accept_legal'), 0); assert.equal(p.dialog.prompt.version, '2026-09-07');
  assert.match(p.dialog.prompt.error, /loaded/, 'nothing changed from the person\'s side: the first read failed');
  await p.submit();
  assert.deepEqual(accepted(p), ['2026-09-07']); assert.equal(p.dialog.prompt, null);
  assert.equal(await result, 'user'); p.root.unmount();
});
test('an account that already accepted the required bundle enters even when the first read failed', async () => {
  const p = setup(); await p.settle(); p.state.status = { error: { message: 'Failed to fetch' } };
  const result = p.ctx.signInWithGoogle(); await p.settle();
  p.state.status = earlier();
  await p.submit();
  assert.equal(p.count('accept_legal'), 0, 'nothing to record');
  assert.equal(p.dialog.prompt, null, 'not asked again'); assert.equal(await result, 'user');
  assert.equal(cachedVersion(p), '2026-09-07'); p.root.unmount();
});
// The device learning which bundle is required must retire every earlier cached
// receipt, whichever path learnt it and even when one account's delete fails.
test('a save that fails after the server required the new bundle cannot reopen the account offline', async () => {
  const p = setup({ cache: earlier(), failRequired: true }); await p.settle();
  p.state.status = { error: { message: 'Failed to fetch' } };
  const result = p.ctx.signInWithGoogle(); await p.settle();
  p.state.status = { version: p.legal.LEGAL_VERSION, accepted_at: null }; p.state.save = { error: { message: 'Failed to fetch' } };
  await p.submit();
  assert.match(p.dialog.prompt.error, /save/); assert.equal(cachedVersion(p), undefined);
  p.root.unmount(); assert.equal(await result, null);
  const next = setup({ restored: true, disk: p.disk, status: new Error('offline') }); await next.settle();
  assert.equal(next.ctx.role, 'guest'); next.root.unmount();
});
test('a cached receipt that cannot be deleted still cannot reopen the account once the new bundle was seen', async () => {
  const first = setup({ restored: true, cache: earlier(), failRemove: true }); await first.settle();
  assert.equal(first.ctx.role, 'guest'); assert.equal(cachedVersion(first), '2026-09-07', 'the delete failed');
  first.root.unmount();
  const next = setup({ restored: true, disk: first.disk, status: new Error('offline') }); await next.settle();
  assert.equal(next.ctx.role, 'guest', 'the device remembers which bundle the server requires'); next.root.unmount();
});
test('once the new bundle is required, another account\'s earlier receipt on this device is not honoured', async () => {
  const p = setup({ restored: true }); await p.settle();
  p.disk.set('itala.legal.receipt.v1.account-z', JSON.stringify(earlier()));
  assert.equal(await p.legal.cachedLegalReceipt('account-z'), null); p.root.unmount();
});
test('a version change clears the tick in the same render and is spoken', async () => {
  const p = setup(); await p.settle(); let continued = 0;
  const root = HookRuntime.render(p.component.LegalAcknowledgement, { prompt: { version: '2026-09-07', returning: false, busy: false, error: null },
    onContinue: () => continued++, onCancel() {}, onDismiss() {} });
  const checkbox = () => nodes(root.element).find(n => n.props?.accessibilityRole === 'checkbox');
  const agree = () => nodes(root.element).find(n => n.props?.accessibilityRole === 'button');
  checkbox().props.onPress(); root.flush(); assert.equal(checkbox().props.accessibilityState.checked, true);
  root.props.prompt = { ...root.props.prompt, version: p.legal.LEGAL_VERSION, error: 'The legal documents have changed. Please review them, then continue.' };
  root.invalidate(); root.renderOnce();
  assert.equal(checkbox().props.accessibilityState.checked, false, 'never drawn with the earlier version\'s tick');
  agree().props.onPress(); assert.equal(continued, 0);
  root.flush();
  assert.deepEqual(p.calls.filter(c => c[0] === 'announce').map(c => c[1]), [root.props.prompt.error]);
  root.unmount(); p.root.unmount();
});

// A case that awaits something which never settles empties the event loop, and
// Node would then exit 0 here with every later case silently skipped.
let finished = false;
process.on('exit', () => {
  if (!finished) { console.error('  FAIL the legal suite stopped before every case ran'); process.exitCode = 1; }
});
(async () => {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`  PASS ${name}`); }
    catch (e) { failed++; console.error(`  FAIL ${name}\n${e.stack}`); }
  }
  console.log(`Legal: ${cases.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
  finished = true;
})();

