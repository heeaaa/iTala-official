'use strict';
// Which sign-in button says "Signing in…".
//
// Apple's and Google's buttons were given one shared busy flag, and only
// Google's can show text, so tapping "Continue with Apple" put "Signing in…" on
// the Google button. This runs the real buttons, the sign-in modal and profile
// sheet, and all five screens that offer sign-in, with the existing hook
// harness. It checks the elements each screen hands to React Native; how
// Apple's native control looks under the label still needs a device (R54).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const Hooks = require('./harness/pkg/react-live');

function load(file, imports = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText, { exports, Map, Set, Promise, setTimeout, clearTimeout,
    require: name => { if (!(name in imports)) throw Error(`Missing import ${name}`); return imports[name]; } });
  return exports;
}
function nodes(n) {
  if (!n || typeof n !== 'object') return [];
  return Array.isArray(n) ? n.flatMap(nodes) : [n, ...nodes(n.props?.children)];
}
const SIGNING_IN = 'Signing in…';

const theme = load('src/theme.ts');
const format = load('src/lib/format.ts');
const stats = load('src/lib/stats.ts', { './format': format, '../theme': theme });
const rn = Object.fromEntries(['View', 'Text', 'Pressable', 'ScrollView', 'ActivityIndicator', 'TouchableOpacity',
  'TextInput', 'Image', 'FlatList', 'RefreshControl'].map(x => [x, x]));
rn.StyleSheet = { create: x => x, absoluteFill: {} };
rn.Platform = { OS: 'ios' };
const alerts = [];
rn.Alert = { alert: (...args) => alerts.push(args) };
rn.Linking = { openURL: async () => {} };
rn.Share = { share: async () => {} };
rn.useWindowDimensions = () => ({ width: 390, height: 844 });
rn.Animated = { View: 'Animated.View', Value: class { interpolate() { return 0; } },
  timing: () => ({ start(done) { done?.(); } }) };
const uiImports = {
  react: Hooks, 'react-native': rn, '../theme': theme,
  'react-native-gesture-handler': {}, 'react-native-safe-area-context': {},
  'expo-linear-gradient': { LinearGradient: 'LinearGradient' },
  'expo-apple-authentication': {
    AppleAuthenticationButton: 'AppleNative',
    AppleAuthenticationButtonType: { CONTINUE: 'continue' },
    AppleAuthenticationButtonStyle: { WHITE: 'white' },
  },
  '../../assets/sponsor-bpbl-clothing-inverse.png': 1, '../../assets/sponsor-bpbl-clothing.png': 2,
  '../../assets/google-g.png': 3,
};
const ui = load('src/components/ui.tsx', uiImports);
// Screens get the real sign-in components; everything else stays a named
// placeholder so the test does not depend on unrelated layout.
const screenUi = new Proxy({}, { get: (_, name) =>
  ['SignInModal', 'ProfileSheet', 'AppleButton', 'GoogleButton', 'AUTH_BUTTON_HEIGHT'].includes(name) ? ui[name] : String(name) });

const roots = [];
function expand(element, overrides = {}) {
  const root = Hooks.render(element.type, { ...element.props, ...overrides });
  roots.push(root);
  return root.element;
}
function unmountAll() { while (roots.length) roots.pop().unmount(); }

// What a person sees on one button: does it say "Signing in…", and can it be tapped?
function look(button) {
  const shown = expand(button);
  const text = nodes(shown).flatMap(n => [n.props?.children].flat()).filter(c => typeof c === 'string');
  return {
    signingIn: text.includes(SIGNING_IN),
    disabled: shown.props.disabled === true || shown.props.pointerEvents === 'none',
  };
}
// Both buttons as rendered by a screen, opening its modal or sheet if that is
// where they live. Closed sheets still carry the props they would open with.
function signInButtons(tree) {
  let shown = nodes(tree);
  for (const host of shown.filter(n => n.type === ui.SignInModal || n.type === ui.ProfileSheet)) {
    shown = shown.concat(nodes(expand(host, { visible: true })));
  }
  const apple = shown.find(n => n.type === ui.AppleButton);
  const google = shown.find(n => n.type === ui.GoogleButton);
  assert.ok(apple, 'Apple button is offered on iOS');
  assert.ok(google, 'Google button is offered');
  return { apple: look(apple), google: look(google) };
}

// The four states the pair can be in. `restoring` is launch: AdminProvider is
// busy restoring a saved session and nobody has tapped anything.
const STATES = {
  'Apple sign-in in flight': { authBusy: true, signingInWith: 'apple', apple: true, google: false, disabled: true },
  'Google sign-in in flight': { authBusy: true, signingInWith: 'google', apple: false, google: true, disabled: true },
  'session restoring at launch': { authBusy: true, signingInWith: null, apple: false, google: false, disabled: true },
  'idle': { authBusy: false, signingInWith: null, apple: false, google: false, disabled: false },
};

const expected = s => ({
  apple: { signingIn: s.apple, disabled: s.disabled },
  google: { signingIn: s.google, disabled: s.disabled },
});

let admin = {};
const guestAdmin = s => ({
  role: 'guest', isAdmin: false, user: null, userId: 'guest-id', appleAvailable: true,
  authBusy: s.authBusy, signingInWith: s.signingInWith,
  errorFor: () => null, clearError() {}, signInWithGoogle: async () => null, signInWithApple: async () => null,
  signOut: async () => {}, unlock: async () => false, lock: async () => {}, deleteAccount: async () => false,
  redeemCode: async () => ({ type: 'error', message: '' }), createCreationCode: async () => null,
  reloadMemberships: async () => {}, isOwner: () => false, canScore: () => false, canScoreGame: () => false,
});

const league = { id: 'l', name: 'League', season: 'S1', kind: 'league', games: [
  { id: 'g', homeTeamId: 'h', awayTeamId: 'a', status: 'final' }],
teams: [{ id: 'h', name: 'Home', color: '#123456', playerIds: ['p'] }, { id: 'a', name: 'Away', color: '#654321', playerIds: [] }],
players: [{ id: 'p', name: 'Player', num: '1' }], events: [] };
const navigation = { navigate() {}, goBack() {}, replace() {} };
const store = {
  state: { leagues: [] }, ready: true, prefs: { favLeagueIds: [], seenOnboarding: true }, prefsReady: true,
  synced: true, sync: { tone: 'ok' }, initialSyncDone: true, liveElsewhere: [], dispatch() {},
  refresh: async () => 'ok', toggleFavLeague() {}, dismissOnboarding() {}, setHaptics() {}, setNotifs() {},
};
const common = {
  react: Hooks, 'react-native': rn, '../theme': theme, '../components/ui': screenUi,
  '../store/AdminProvider': { useAdmin: () => admin },
  '../store/StoreProvider': { useStore: () => store, useLeague: () => league, reducer: x => x },
  '../lib/stats': stats, '../lib/format': format,
  'react-native-view-shot': { captureRef: async () => '' }, 'expo-linear-gradient': { LinearGradient: 'LinearGradient' },
  'expo-sharing': {},
};
const ENTRANCES = {
  'Box score share prompt': [load('src/screens/BoxScoreScreen.tsx', { ...common,
    '../components/PlayLog': { PlayLogRow: 'PlayLogRow' } }).default, { leagueId: 'l', gameId: 'g' }],
  'Player card share prompt': [load('src/screens/PlayerProfileScreen.tsx', common).default, { leagueId: 'l', playerId: 'p' }],
  'Home profile sheet': [load('src/screens/LeaguesScreen.tsx', { ...common,
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
    '../lib/usePromos': { usePromos: () => ({ activePromos: [], reload: async () => {} }), onPromoTap() {} },
    '../lib/legal': { PRIVACY_POLICY_URL: 'https://example.invalid/privacy' } }).default, {}],
  'Settings sign-in gate': [load('src/screens/SettingsScreen.tsx', { ...common,
    '../components/LegalAcknowledgement': { LegalLinks: 'LegalLinks' } }).default, {}],
  'Drop-in sign-in gate': [load('src/screens/RecGameScreen.tsx', { ...common,
    '../sync/recSetup': { loadRecSetup: async () => null }, '../sync/supabase': { getSupabase: () => null } }).default, {}],
};
// RecGameScreen keys its editor by user; the gate lives in the editor.
function renderScreen(Screen, params) {
  let tree = expand({ type: Screen, props: { route: { params }, navigation } });
  while (tree && typeof tree.type === 'function' && !Object.values(ui).includes(tree.type)) tree = expand(tree);
  return tree;
}

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`PASS ${label}`); }
  catch (e) { failures++; console.error(`FAIL ${label}: ${e.message}`); }
  finally { unmountAll(); }
}

// The two buttons on their own.
for (const [name, s] of Object.entries(STATES)) {
  check(`buttons, ${name}: only the provider in flight says "${SIGNING_IN}"`, () => {
    const apple = look({ type: ui.AppleButton, props: { onPress() {}, busy: s.authBusy, signingIn: s.signingInWith === 'apple' } });
    const google = look({ type: ui.GoogleButton, props: { onPress() {}, busy: s.authBusy, signingIn: s.signingInWith === 'google' } });
    assert.deepEqual({ apple, google }, expected(s));
  });
}

// Every place the app offers sign-in, wired from what useAdmin reports.
for (const [entrance, [Screen, params]] of Object.entries(ENTRANCES)) {
  for (const [name, s] of Object.entries(STATES)) {
    check(`${entrance}, ${name}`, () => {
      admin = guestAdmin(s);
      const { apple, google } = signInButtons(renderScreen(Screen, params));
      assert.deepEqual({ apple, google }, expected(s));
    });
  }
}

// The label Apple's button shows has to be announced, and the native control
// beneath it, which still says "Continue with Apple", must not be.
check('Apple in flight: VoiceOver hears the progress label, not the covered native title', () => {
  const shown = expand({ type: ui.AppleButton, props: { onPress() {}, busy: true, signingIn: true } });
  const native = nodes(shown).find(n => n.type === 'AppleNative');
  assert.equal(native.props.accessibilityElementsHidden, true);
  const label = nodes(shown).find(n => n.props?.accessibilityRole === 'button');
  assert.ok(label, 'progress label is exposed as the button');
  assert.equal(label.props.accessibilityLabel, 'Signing in with Apple');
  assert.equal(label.props.accessibilityState.busy, true);
  assert.equal(label.props.accessibilityState.disabled, true);
});
check('Apple idle: native control is untouched and reachable', () => {
  const shown = expand({ type: ui.AppleButton, props: { onPress() {} } });
  const native = nodes(shown).find(n => n.type === 'AppleNative');
  assert.notEqual(native.props.accessibilityElementsHidden, true);
  assert.ok(!nodes(shown).some(n => n.props?.accessibilityLabel === 'Signing in with Apple'));
});
check('Android: no Apple button, and Google says "Signing in…" only while Google runs', () => {
  const android = load('src/components/ui.tsx', { ...uiImports,
    'react-native': { ...rn, Platform: { OS: 'android' } }, 'expo-apple-authentication': {} });
  assert.equal(expand({ type: android.AppleButton, props: { onPress() {}, busy: true, signingIn: true } }), null);
  assert.deepEqual(look({ type: android.GoogleButton, props: { onPress() {}, busy: true, signingIn: true } }),
    { signingIn: true, disabled: true });
  assert.deepEqual(look({ type: android.GoogleButton, props: { onPress() {}, busy: true } }),
    { signingIn: false, disabled: true });
});

// Two more labels that belong to one action only: the Home sheet's sign-out
// row and Settings' Delete account. Signing in sets the flags they were read
// from, and the account appears before sign-in finishes (its admin and
// membership reads run after it is set), so signing in briefly read
// "Signing out…" or "Deleting…".
const tick = () => new Promise(r => setImmediate(r));
async function settle(root) { for (let i = 0; i < 10; i++) { await tick(); root.flush(); } }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const account = { id: 'account-a', name: 'Account', email: 'a@example.invalid', avatarUrl: null, providers: ['apple'] };
const signedIn = (extra = {}) => ({ ...guestAdmin(STATES.idle), role: 'user', user: account, userId: account.id, ...extra });
const Leagues = ENTRANCES['Home profile sheet'][0], Settings = ENTRANCES['Settings sign-in gate'][0];
function mount(Screen) {
  const root = Hooks.render(Screen, { route: { params: {} }, navigation });
  roots.push(root);
  return root;
}
const sheetOf = root => nodes(root.element).find(n => n.type === ui.ProfileSheet);
function signOutRow(root) {
  const row = nodes(expand(sheetOf(root), { visible: true })).find(n => /^Sign(ing)? out/.test(n.props?.label ?? ''));
  assert.ok(row, 'the signed-in sheet offers sign out');
  return { label: row.props.label, disabled: !!row.props.disabled };
}
function deleteButton(root) {
  const button = nodes(root.element).find(n => n.type === 'Button' && n.props.kind === 'danger');
  assert.ok(button, 'signed-in Settings offers Delete account');
  return { title: button.props.title, disabled: !!button.props.disabled };
}
const asyncChecks = [];
const checkAsync = (label, fn) => asyncChecks.push([label, fn]);

checkAsync('Home sheet: finishing a sign-in, or restoring a session, never reads "Signing out…"', async () => {
  for (const state of [{ authBusy: true, signingInWith: 'apple' }, { authBusy: true, signingInWith: 'google' }, { authBusy: true }]) {
    admin = signedIn(state);
    const root = mount(Leagues);
    assert.deepEqual(signOutRow(root), { label: 'Sign out', disabled: true }, JSON.stringify(state));
    unmountAll();
  }
});
checkAsync('Home sheet: signing out still reads "Signing out…", then closes the sheet', async () => {
  const gate = deferred();
  let root;
  admin = signedIn({ signOut: async () => {
    admin = { ...admin, authBusy: true }; root.invalidate();
    await gate.promise;
    admin = signedIn(); root.invalidate();
  } });
  root = mount(Leagues);
  nodes(root.element).find(n => n.type === 'ProfileButton').props.onPress(); root.flush();
  assert.equal(sheetOf(root).props.visible, true, 'the profile button opens the sheet');
  sheetOf(root).props.onSignOut(); await settle(root);
  assert.deepEqual(signOutRow(root), { label: 'Signing out…', disabled: true });
  gate.resolve(); await settle(root);
  assert.equal(sheetOf(root).props.visible, false, 'the sheet closes once signed out');
  assert.deepEqual(signOutRow(root), { label: 'Sign out', disabled: false });
});
checkAsync('Settings: signing in from the gate never reads "Deleting…"', async () => {
  const gate = deferred();
  let root;
  admin = guestAdmin(STATES.idle);
  admin.signInWithApple = async () => {
    // Apple has answered and the account is set; the admin and membership reads are still running.
    admin = signedIn({ authBusy: true, signingInWith: 'apple' }); root.invalidate();
    await gate.promise;
    admin = signedIn(); root.invalidate();
    return 'user';
  };
  root = mount(Settings);
  nodes(root.element).find(n => n.type === ui.AppleButton).props.onPress(); await settle(root);
  assert.deepEqual(deleteButton(root), { title: 'Delete account', disabled: true });
  gate.resolve(); await settle(root);
  assert.deepEqual(deleteButton(root), { title: 'Delete account', disabled: false });
});
checkAsync('Settings: deleting the account still reads "Deleting…" until it answers', async () => {
  const gate = deferred();
  admin = signedIn({ deleteAccount: () => gate.promise });
  const root = mount(Settings);
  nodes(root.element).find(n => n.type === 'Button' && n.props.kind === 'danger').props.onPress();
  const [, , choices] = alerts.pop();
  choices.find(c => c.style === 'destructive').onPress(); await settle(root);
  assert.deepEqual(deleteButton(root), { title: 'Deleting…', disabled: true });
  gate.resolve('cancelled'); await settle(root);
  assert.deepEqual(deleteButton(root), { title: 'Delete account', disabled: false });
});

// A case that awaits something which never settles would empty the event loop
// and exit 0 with later cases skipped; fail the run instead.
let finished = false;
process.on('exit', () => {
  if (!finished) { console.error('FAIL the sign-in progress suite stopped before every case ran'); process.exitCode = 1; }
});
(async () => {
  for (const [label, fn] of asyncChecks) {
    try { await fn(); console.log(`PASS ${label}`); }
    catch (e) { failures++; console.error(`FAIL ${label}: ${e.message}`); }
    finally { unmountAll(); }
  }
  process.exitCode = failures ? 1 : 0;
  finished = true;
})();
