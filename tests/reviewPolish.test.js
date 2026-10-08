'use strict';
// App Review polish for build 3: sign-in copy that names Apple first, the Home
// empty state on a first launch that cannot reach the server, and no
// debug-looking device id in Settings.
//
// Runs the real Home and Settings screens, onboarding sheet and profile sheet on
// the existing hook harness, the same way signInProgress.test.js does. It checks
// the elements each screen hands to React Native; how they look on a device
// still needs the manual checklist.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Hooks = require('./harness/pkg/react-live');

function load(file, imports = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText, { exports, Map, Set, Promise, setTimeout, clearTimeout, ...globals,
    require: name => { if (!(name in imports)) throw Error(`Missing import ${name}`); return imports[name]; } });
  return exports;
}
// A clock the test moves by hand, so a 15 s limit is checked without waiting 15 s.
function fakeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + (ms || 0) }); return id; },
    clearTimeout: id => { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) { timers.delete(id); t.fn(); }
      }
    },
    pending: () => timers.size,
  };
}
function nodes(n) {
  if (!n || typeof n !== 'object') return [];
  return Array.isArray(n) ? n.flatMap(nodes) : [n, ...nodes(n.props?.children)];
}
const strings = tree => nodes(tree).flatMap(n => [n.props?.children].flat()).filter(c => typeof c === 'string');

const theme = load('src/theme.ts');
const format = load('src/lib/format.ts');
const stats = load('src/lib/stats.ts', { './format': format, '../theme': theme });
const rn = Object.fromEntries(['View', 'Text', 'Pressable', 'ScrollView', 'ActivityIndicator', 'TouchableOpacity',
  'TextInput', 'Image', 'FlatList', 'RefreshControl', 'Modal'].map(x => [x, x]));
rn.StyleSheet = { create: x => x, absoluteFill: {} };
rn.Platform = { OS: 'ios' };
rn.Alert = { alert() {} };
rn.Linking = { openURL: async () => {} };
rn.Share = { share: async () => {} };
rn.useWindowDimensions = () => ({ width: 390, height: 844 });
rn.Animated = { View: 'Animated.View', Value: class { interpolate() { return 0; } },
  timing: () => ({ start(done) { done?.(); } }) };
const ui = load('src/components/ui.tsx', {
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
});
// Screens get named placeholders for every shared component, so each one's
// props (an Empty's title, a Button's title, a modal's message) are readable.
const screenUi = new Proxy({}, { get: (_, name) => String(name) });

let admin = {};
const guestAdmin = () => ({
  role: 'guest', isAdmin: false, user: null, userId: 'guest-id-123456789', appleAvailable: true,
  authBusy: false, signingInWith: null,
  errorFor: () => null, clearError() {}, signInWithGoogle: async () => null, signInWithApple: async () => null,
  signOut: async () => {}, unlock: async () => false, lock: async () => {}, deleteAccount: async () => false,
  redeemCode: async () => ({ type: 'error', message: '' }), createCreationCode: async () => null,
  reloadMemberships: async () => {}, isOwner: () => false, canScore: () => false, canScoreGame: () => false,
});
const account = { id: 'account-a1b2c3d4e5', name: 'Account', email: 'a@example.invalid', avatarUrl: null, providers: ['apple'] };
const userAdmin = () => ({ ...guestAdmin(), role: 'user', user: account, userId: account.id });

const cachedLeague = { id: 'l', name: 'Cached League', season: 'S1', kind: 'league', games: [],
  teams: [], players: [], events: [] };
let store = {};
const baseStore = (over = {}) => ({
  state: { leagues: [] }, ready: true, prefs: { favLeagueIds: [], seenOnboarding: true }, prefsReady: true,
  synced: true, sync: { tone: 'ok', label: 'Synced', detail: '', pending: 0, phase: 'idle' },
  initialSyncDone: true, net: 'online', pendingWrites: 0, liveElsewhere: [], dispatch() {},
  refreshCalls: 0, refresh: async () => { store.refreshCalls++; return 'refreshed'; },
  toggleFavLeague() {}, dismissOnboarding() {}, setHaptics() {}, setNotifs() {},
  ...over,
});
const navigation = { navigate() {}, goBack() {}, replace() {} };
const common = {
  react: Hooks, 'react-native': rn, '../theme': theme, '../components/ui': screenUi,
  '../store/AdminProvider': { useAdmin: () => admin },
  '../store/StoreProvider': { useStore: () => store, reducer: x => x },
  '../lib/stats': stats, '../lib/format': format,
};
const leaguesImports = { ...common,
  'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
  '../lib/usePromos': { usePromos: () => ({ activePromos: [], reload: async () => {} }), onPromoTap() {} },
  '../lib/legal': { PRIVACY_POLICY_URL: 'https://example.invalid/privacy' } };
const Leagues = load('src/screens/LeaguesScreen.tsx', leaguesImports).default;
// The same screen on the hand-moved clock, for the pull-to-refresh time limit.
const clock = fakeClock();
const TimedLeagues = load('src/screens/LeaguesScreen.tsx', leaguesImports,
  { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }).default;
const Settings = load('src/screens/SettingsScreen.tsx', { ...common,
  '../components/LegalAcknowledgement': { LegalLinks: 'LegalLinks' } }).default;

const roots = [];
function mount(Screen) {
  const root = Hooks.render(Screen, { route: { params: {} }, navigation });
  roots.push(root);
  return root;
}
function expand(element, overrides = {}) {
  const root = Hooks.render(element.type, { ...element.props, ...overrides });
  roots.push(root);
  return root.element;
}
function unmountAll() { while (roots.length) roots.pop().unmount(); }
const tick = () => new Promise(r => setImmediate(r));
async function settle(root) { for (let i = 0; i < 10; i++) { await tick(); root.flush(); } }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

// What Home's league list shows when it has no rows to show.
function homeList(root) {
  const list = nodes(root.element).find(n => n.type === 'FlatList');
  assert.ok(list, 'Home renders its league list');
  const shown = nodes(list.props.ListEmptyComponent);
  const empty = shown.find(n => n.type === 'Empty');
  const button = shown.find(n => n.type === 'Button');
  return {
    rows: list.props.data.map(l => l.name),
    spinner: shown.some(n => n.type === 'ActivityIndicator'),
    title: empty ? empty.props.title : null,
    subtitle: empty ? empty.props.subtitle : null,
    button: button ? { title: button.props.title, disabled: !!button.props.disabled, onPress: button.props.onPress } : null,
  };
}
const toastOf = root => nodes(root.element).find(n => n.type === 'Toast').props.message;

const checks = [];
const check = (label, fn) => checks.push([label, fn]);

// ---- Sign-in copy names Apple first ----------------------------------------

check('onboarding: "Sign in to run games" names Apple before Google', async () => {
  const sheet = expand({ type: ui.OnboardingSheet, props: { visible: true, isSignedIn: false, onClose() {}, onNeverShow() {} } });
  const row = nodes(sheet).find(n => n.props?.title === 'Sign in to run games');
  assert.ok(row, 'the onboarding sheet has the sign-in row');
  assert.equal(row.props.body, 'Sign in with Apple or Google to set up leagues and share box scores or player cards.');
});

check('guest profile sheet: says what signing in unlocks, not "Admins are recognized automatically"', async () => {
  const sheet = expand({ type: ui.ProfileSheet, props: { visible: true, onClose() {}, user: null, role: 'guest',
    onGoogle() {}, onApple() {}, onSignOut() {}, onSettings() {}, onAbout() {}, onEnterCode() {} } });
  const text = strings(sheet);
  assert.ok(text.includes('Sign in to run games, create a league with a code, and share stat cards.'), JSON.stringify(text));
  assert.ok(!text.some(t => /Admins are recognized/.test(t)), JSON.stringify(text));
});

check('backup admin unlock: the message no longer names Google only', async () => {
  admin = guestAdmin(); store = baseStore();
  const modal = nodes(mount(Leagues).element).find(n => n.type === 'PasswordModal');
  assert.ok(modal, 'Home carries the admin password modal');
  assert.equal(modal.props.message, 'Backup admin unlock. Enter the admin password to unlock stat tracking without signing in.');
});

check('invite share text names Apple before Google', async () => {
  const src = fs.readFileSync('src/screens/LeagueDetailScreen.tsx', 'utf8');
  const share = src.split('\n').find(line => line.includes('Share.share({ message: `Join "'));
  assert.ok(share, 'the invite share message is still built in LeagueDetailScreen');
  assert.ok(share.includes('Sign in with Apple or Google, open the profile menu'), share);
});

check('no app copy puts Google before Apple', async () => {
  const offenders = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.tsx?$/.test(entry.name)) {
        fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          // Developer comments are not copy anybody reads in the app.
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          if (/Google or Apple/.test(line)) offenders.push(`${file}:${i + 1}`);
        });
      }
    }
  };
  walk('src');
  assert.deepEqual(offenders, []);
});

// ---- Home on a first launch that cannot reach the server --------------------

check('first launch offline: "Can\'t reach iTala" with Try again, not an endless spinner', async () => {
  admin = guestAdmin(); store = baseStore({ net: 'offline', initialSyncDone: false });
  const shown = homeList(mount(Leagues));
  assert.equal(shown.spinner, false);
  assert.equal(shown.title, 'Can\'t reach iTala');
  assert.equal(shown.subtitle, 'Check your internet connection, then try again.');
  assert.deepEqual({ title: shown.button?.title, disabled: shown.button?.disabled }, { title: 'Try again', disabled: false });
});

check('first launch offline, boot retries given up: still "Can\'t reach iTala", not "Create your first league"', async () => {
  admin = guestAdmin(); store = baseStore({ net: 'offline', initialSyncDone: true });
  const shown = homeList(mount(Leagues));
  assert.equal(shown.title, 'Can\'t reach iTala');
  assert.ok(shown.button, 'Try again is offered');
});

check('Try again runs the same refresh as pull-to-refresh, is held while it runs, and reports a failure', async () => {
  const gate = deferred();
  admin = guestAdmin();
  store = baseStore({ net: 'offline', initialSyncDone: false });
  store.refresh = async () => { store.refreshCalls++; await gate.promise; return 'offline'; };
  const root = mount(Leagues);
  homeList(root).button.onPress(); await settle(root);
  assert.equal(store.refreshCalls, 1);
  assert.deepEqual({ title: homeList(root).button.title, disabled: homeList(root).button.disabled },
    { title: 'Trying…', disabled: true });
  gate.resolve(); await settle(root);
  assert.equal(toastOf(root), 'No internet connection. Please try again.');
  assert.deepEqual({ title: homeList(root).button.title, disabled: homeList(root).button.disabled },
    { title: 'Try again', disabled: false });
});

check('offline with leagues already on the device: the leagues show, no offline empty state needed', async () => {
  admin = guestAdmin(); store = baseStore({ net: 'offline', initialSyncDone: false, state: { leagues: [cachedLeague] } });
  assert.deepEqual(homeList(mount(Leagues)).rows, ['Cached League']);
});

check('normal launch still loading (connection not known yet): spinner, unchanged', async () => {
  admin = guestAdmin(); store = baseStore({ net: 'unknown', initialSyncDone: false });
  const shown = homeList(mount(Leagues));
  assert.deepEqual({ spinner: shown.spinner, title: shown.title, button: shown.button }, { spinner: true, title: null, button: null });
});

check('online and loading: spinner, unchanged', async () => {
  admin = guestAdmin(); store = baseStore({ net: 'online', initialSyncDone: false });
  assert.equal(homeList(mount(Leagues)).spinner, true);
});

check('online, loaded, no leagues, guest: no "Create your first league" (guests cannot)', async () => {
  admin = guestAdmin(); store = baseStore();
  const shown = homeList(mount(Leagues));
  assert.equal(shown.title, 'No leagues yet');
  assert.equal(shown.subtitle, 'Leagues appear here once they are published. Pull down to refresh.');
  assert.equal(shown.button, null);
});

check('online, loaded, no leagues, signed in: "Create your first league", unchanged', async () => {
  admin = userAdmin(); store = baseStore();
  const shown = homeList(mount(Leagues));
  assert.equal(shown.title, 'No leagues yet');
  assert.equal(shown.subtitle, 'Create your first league to start tracking games.');
});

check('a search with no matches still says "No matches", even offline', async () => {
  // The search box only appears once there are three leagues.
  const leagues = ['A', 'B', 'C'].map(n => ({ ...cachedLeague, id: n, name: n }));
  admin = guestAdmin(); store = baseStore({ net: 'offline', state: { leagues } });
  const root = mount(Leagues);
  const search = nodes(root.element).find(n => n.type === 'TextInput');
  assert.ok(search, 'the search box shows with three leagues');
  search.props.onChangeText('zzz'); root.flush();
  const shown = homeList(root);
  assert.deepEqual({ rows: shown.rows, title: shown.title, button: shown.button }, { rows: [], title: 'No matches', button: null });
});

// ---- Coming back online ------------------------------------------------------

check('reconnecting with an empty Home refreshes once, so the leagues load', async () => {
  admin = guestAdmin(); store = baseStore({ net: 'offline', initialSyncDone: true });
  const root = mount(Leagues); await settle(root);
  assert.equal(store.refreshCalls, 0, 'nothing is fired while offline');
  store = { ...store, net: 'online' }; root.invalidate(); await settle(root);
  assert.equal(store.refreshCalls, 1);
  root.invalidate(); await settle(root); root.invalidate(); await settle(root);
  assert.equal(store.refreshCalls, 1, 'later renders while online do not refresh again');
});

check('a normal launch (unknown, then online) does not add a refresh', async () => {
  admin = guestAdmin(); store = baseStore({ net: 'unknown', initialSyncDone: false });
  const root = mount(Leagues); await settle(root);
  store = { ...store, net: 'online' }; root.invalidate(); await settle(root);
  assert.equal(store.refreshCalls, 0);
});

check('reconnecting with leagues already showing does not add a refresh', async () => {
  admin = guestAdmin(); store = baseStore({ net: 'offline', state: { leagues: [cachedLeague] } });
  const root = mount(Leagues); await settle(root);
  store = { ...store, net: 'online' }; root.invalidate(); await settle(root);
  assert.equal(store.refreshCalls, 0);
});

// A link that answers reads but drops writes flips offline and online on every
// attempt: the refresh's write fails (offline), its read answers (online). An
// automatic refresh on each flip would loop with no backoff.
check('a link that keeps flipping offline and online gets one automatic refresh, not a loop', async () => {
  admin = guestAdmin(); store = baseStore({ net: 'offline', initialSyncDone: true });
  const root = mount(Leagues); await settle(root);
  for (let i = 0; i < 4; i++) {
    store = { ...store, net: 'online' }; root.invalidate(); await settle(root);
    store = { ...store, net: 'offline' }; root.invalidate(); await settle(root);
  }
  assert.equal(store.refreshCalls, 1);
});

check('a search with no matches is not an empty device: reconnecting does not refresh', async () => {
  const leagues = ['A', 'B', 'C'].map(n => ({ ...cachedLeague, id: n, name: n }));
  admin = guestAdmin(); store = baseStore({ net: 'offline', state: { leagues } });
  const root = mount(Leagues);
  nodes(root.element).find(n => n.type === 'TextInput').props.onChangeText('zzz'); await settle(root);
  store = { ...store, net: 'online' }; root.invalidate(); await settle(root);
  assert.equal(store.refreshCalls, 0);
});

check('a device with only drop-in games is not empty: reconnecting does not refresh', async () => {
  const dropIn = { ...cachedLeague, id: 'rec', name: 'Community', kind: 'recreational', isShared: true };
  admin = guestAdmin(); store = baseStore({ net: 'offline', state: { leagues: [dropIn] } });
  const root = mount(Leagues); await settle(root);
  store = { ...store, net: 'online' }; root.invalidate(); await settle(root);
  assert.equal(store.refreshCalls, 0);
});

check('Try again that finds the connection back runs one refresh, not two', async () => {
  const gate = deferred();
  admin = guestAdmin(); store = baseStore({ net: 'offline', initialSyncDone: true });
  let root;
  // The real refresh pings first; an answer flips the status to online while it runs.
  store.refresh = async () => {
    store.refreshCalls++;
    store = { ...store, net: 'online' }; root.invalidate();
    await gate.promise;
    return 'refreshed';
  };
  root = mount(Leagues); await settle(root);
  homeList(root).button.onPress(); await settle(root);
  gate.resolve(); await settle(root);
  assert.equal(store.refreshCalls, 1);
});

check('the automatic refresh never pops a toast nobody asked for', async () => {
  admin = guestAdmin(); store = baseStore({ net: 'offline', initialSyncDone: true });
  store.refresh = async () => { store.refreshCalls++; return 'offline'; };
  const root = mount(Leagues); await settle(root);
  store = { ...store, net: 'online' }; root.invalidate(); await settle(root);
  assert.equal(store.refreshCalls, 1);
  assert.equal(toastOf(root), null);
});

// ---- Pull-to-refresh has a time limit ---------------------------------------
// With no connection the client's requests can go unanswered for minutes, and
// the spinner used to wait with them. It now stops after 15 s and says so; the
// refresh itself keeps running and still applies whatever it brings back.

const spinnerOf = root => nodes(root.element).find(n => n.type === 'FlatList').props.refreshControl;

// A dead link: nothing answers, so the status never settles to online or offline.
check('pull-to-refresh that never answers stops spinning after 15 s and says there is no connection', async () => {
  admin = guestAdmin(); store = baseStore({ net: 'unknown', state: { leagues: [cachedLeague] } });
  store.refresh = () => { store.refreshCalls++; return new Promise(() => {}); };
  const root = mount(TimedLeagues);
  spinnerOf(root).props.onRefresh(); await settle(root);
  assert.equal(spinnerOf(root).props.refreshing, true, 'spinning while the refresh runs');
  clock.advance(14999); await settle(root);
  assert.equal(spinnerOf(root).props.refreshing, true, 'still spinning just before the limit');
  clock.advance(1); await settle(root);
  assert.equal(spinnerOf(root).props.refreshing, false, 'stopped at the limit');
  assert.equal(toastOf(root), 'No internet connection. Please try again.');
  assert.equal(store.refreshCalls, 1);
});

check('a dead link with stats queued: none are sent, so at 15 s it still says there is no connection', async () => {
  admin = guestAdmin(); store = baseStore({ net: 'unknown', pendingWrites: 5, state: { leagues: [cachedLeague] } });
  store.refresh = () => { store.refreshCalls++; return new Promise(() => {}); };
  const root = mount(TimedLeagues);
  spinnerOf(root).props.onRefresh(); await settle(root);
  clock.advance(15000); await settle(root);
  assert.equal(spinnerOf(root).props.refreshing, false);
  assert.equal(toastOf(root), 'No internet connection. Please try again.');
});

// refresh() sends the outbox before it reads, one request per queued stat, so
// after a game scored with no signal it can run past 15 s on a working
// connection. pendingWrites falls as each one is confirmed.
check('a long upload on a working connection: at 15 s it says changes are still sending, not "No internet"', async () => {
  const done = deferred();
  admin = guestAdmin(); store = baseStore({ pendingWrites: 150, state: { leagues: [cachedLeague] } });
  store.refresh = () => { store.refreshCalls++; return done.promise; };
  const root = mount(TimedLeagues);
  spinnerOf(root).props.onRefresh(); await settle(root);
  store = { ...store, pendingWrites: 11 }; root.invalidate(); await settle(root); // 139 of 150 sent
  clock.advance(15000); await settle(root);
  assert.equal(spinnerOf(root).props.refreshing, false, 'the spinner is still limited');
  assert.equal(toastOf(root), 'Still sending your changes in the background.');
  store = { ...store, pendingWrites: 0 }; root.invalidate();
  clock.advance(1000); done.resolve('refreshed'); await settle(root);
  assert.equal(spinnerOf(root).props.refreshing, false);
  assert.equal(toastOf(root), 'Still sending your changes in the background.', 'the late answer adds no toast of its own');
});

check('the upload finished and only the read is left at 15 s: no toast at all', async () => {
  admin = guestAdmin(); store = baseStore({ pendingWrites: 150, state: { leagues: [cachedLeague] } });
  store.refresh = () => { store.refreshCalls++; return new Promise(() => {}); };
  const root = mount(TimedLeagues);
  spinnerOf(root).props.onRefresh(); await settle(root);
  store = { ...store, pendingWrites: 0 }; root.invalidate(); await settle(root);
  clock.advance(15000); await settle(root);
  assert.equal(spinnerOf(root).props.refreshing, false);
  assert.equal(toastOf(root), null);
});

check('a refresh that answers in time is unchanged: no toast, and the limit is cleared', async () => {
  admin = guestAdmin(); store = baseStore({ state: { leagues: [cachedLeague] } });
  const root = mount(TimedLeagues);
  const before = clock.pending();
  spinnerOf(root).props.onRefresh(); await settle(root);
  assert.equal(spinnerOf(root).props.refreshing, false);
  assert.equal(toastOf(root), null);
  assert.equal(clock.pending(), before, 'no limit timer left behind');
  clock.advance(20000); await settle(root);
  assert.equal(toastOf(root), null, 'nothing fires later');
});

check('an offline answer in time still shows the same toast, as before', async () => {
  admin = guestAdmin(); store = baseStore({ state: { leagues: [cachedLeague] } });
  store.refresh = async () => 'offline';
  const root = mount(TimedLeagues);
  spinnerOf(root).props.onRefresh(); await settle(root);
  assert.equal(spinnerOf(root).props.refreshing, false);
  assert.equal(toastOf(root), 'No internet connection. Please try again.');
});

check('a refresh that answers after the limit leaves the spinner stopped, and pull-to-refresh works again', async () => {
  const late = deferred();
  admin = guestAdmin(); store = baseStore({ state: { leagues: [cachedLeague] } });
  store.refresh = () => { store.refreshCalls++; return late.promise; };
  const root = mount(TimedLeagues);
  spinnerOf(root).props.onRefresh(); await settle(root);
  clock.advance(15000); await settle(root);
  late.resolve('refreshed'); await settle(root);
  assert.equal(spinnerOf(root).props.refreshing, false);
  store.refresh = async () => { store.refreshCalls++; return 'refreshed'; };
  spinnerOf(root).props.onRefresh(); await settle(root);
  assert.equal(store.refreshCalls, 2, 'a second pull runs');
  assert.equal(spinnerOf(root).props.refreshing, false);
  assert.equal(toastOf(root), null, 'a good answer clears the earlier toast');
});

check('Try again on the offline Home has the same 15 s limit', async () => {
  admin = guestAdmin(); store = baseStore({ net: 'offline', initialSyncDone: true });
  store.refresh = () => { store.refreshCalls++; return new Promise(() => {}); };
  const root = mount(TimedLeagues);
  homeList(root).button.onPress(); await settle(root);
  assert.equal(homeList(root).button.title, 'Trying…');
  clock.advance(15000); await settle(root);
  assert.deepEqual({ title: homeList(root).button.title, disabled: homeList(root).button.disabled },
    { title: 'Try again', disabled: false });
  assert.equal(toastOf(root), 'No internet connection. Please try again.');
});

// ---- Settings ----------------------------------------------------------------

check('Settings, signed in: no "Device: …" id under the sync status', async () => {
  admin = userAdmin(); store = baseStore();
  const text = strings(mount(Settings).element);
  assert.ok(text.some(t => t === 'Sync'), 'the Sync card still renders');
  assert.ok(!text.some(t => /Device:/.test(t)), JSON.stringify(text.filter(t => /Device/.test(t))));
  assert.ok(!text.some(t => t.includes(account.id.slice(0, 8))), 'no part of the account id is shown');
});

// A case that awaits something which never settles would empty the event loop
// and exit 0 with later cases skipped; fail the run instead.
let finished = false;
let failures = 0;
process.on('exit', () => {
  if (!finished) { console.error('FAIL the review polish suite stopped before every case ran'); process.exitCode = 1; }
});
(async () => {
  for (const [label, fn] of checks) {
    try { await fn(); console.log(`PASS ${label}`); }
    catch (e) { failures++; console.error(`FAIL ${label}: ${e.message}`); }
    finally { unmountAll(); }
  }
  console.log(`${checks.length - failures}/${checks.length} review polish checks passed`);
  process.exitCode = failures ? 1 : 0;
  finished = true;
})();
