// Actual setup screen/service plus actual reducer. Native layout needs device QA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Hooks = require('./harness/pkg/react-live');
const { reducer } = require('./.test-bundle');

function nodes(n) {
  if (!n || typeof n !== 'object') return [];
  if (Array.isArray(n)) return n.flatMap(nodes);
  return [n, ...nodes(n.props?.children)];
}
function harness() {
  const h = { state: { leagues: [] }, actor: 'u1', synced: true, calls: [], actions: [], routes: [],
    disk: new Map(), receipts: new Map(), failure: null, loseReply: false, storageFails: false };
  const modules = new Map(); let id = 0;
  const sb = { auth: { getSession: async () => ({ data: { session: { user: { id: h.actor } } } }) },
    rpc: (_name, args) => {
      h.calls.push(JSON.parse(JSON.stringify(args)));
      const response = (async () => {
        if (h.wait) await h.wait;
        if (h.failure !== null) return { error: { message: 'refused' }, status: h.failure };
        const key = args.p_setup.game_id;
        const before = h.receipts.get(key);
        if (before && JSON.stringify(before) !== JSON.stringify(args)) return { error: {}, status: 400 };
        h.receipts.set(key, args);
        if (!before && h.loseReply) return { error: { message: 'Network request failed' }, status: 0 };
        return { data: { game_id: key }, error: null, status: 200 };
      })();
      response.abortSignal = () => response;
      return response;
    },
  };
  const dispatch = a => { h.actions.push(a); h.state = reducer(h.state, a); };
  function load(file) {
    const full = path.resolve(file);
    if (modules.has(full)) return modules.get(full);
    const exports = {}; modules.set(full, exports);
    const imports = {
      react: Hooks,
      'react-native': Object.fromEntries(['View', 'ScrollView', 'TextInput', 'Pressable'].map(x => [x, x])),
      '@react-native-async-storage/async-storage': { default: {
        getItem: async k => h.disk.get(k) ?? null,
        setItem: async (k, v) => { if (h.storageFails) throw Error('disk full'); h.disk.set(k, v); },
        removeItem: async k => h.disk.delete(k),
      } },
    };
    const requireModule = name => {
      if (name in imports) return imports[name];
      if (name.endsWith('/components/ui')) return Object.fromEntries(['Screen', 'Txt', 'Card', 'Button', 'Field', 'Toggle', 'GoogleButton', 'AppleButton'].map(x => [x, x]));
      if (name.endsWith('/store/StoreProvider')) return { reducer, useStore: () => ({ state: h.state, dispatch, synced: h.synced }) };
      if (name.endsWith('/store/AdminProvider')) return { useAdmin: () => ({ role: 'user', userId: h.actor, isOwner: () => true, reloadMemberships: async () => {} }) };
      if (name.endsWith('/theme')) return { colors: {}, space: x => x, radius: {}, font: {}, teamColors: ['red', 'blue'] };
      if (name.endsWith('/lib/format')) return { uid: () => `id-${++id}` };
      if (name.endsWith('/lib/log')) return { devLog() {} };
      if (name.endsWith('/sync/supabase')) return { getSupabase: () => sb };
      if (name === './sync') return { fetchLeagueDetail: async () => {
        if (h.readFails) return null;
        const raw = [...h.disk.values()][0];
        const bundle = raw ? JSON.parse(raw).bundle : null;
        if (bundle && h.readFinal) bundle.games[0].status = 'final';
        if (bundle && h.readMissingTeam) bundle.teams.pop();
        return bundle;
      } };
      if (name.startsWith('.')) return load(path.resolve(path.dirname(full), name + '.ts'));
      throw Error(`Missing import ${name}`);
    };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(full, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
    }).outputText, { exports, require: requireModule, setTimeout, clearTimeout, AbortController, TypeError });
    return exports;
  }
  const Screen = load('src/screens/RecGameScreen.tsx').default;
  h.service = load('src/sync/recSetup.ts');
  h.mount = () => {
    const outer = Hooks.render(Screen, { navigation: { replace: (...args) => h.routes.push(args) } });
    const editor = outer.element; outer.unmount();
    h.root = Hooks.render(editor.type, editor.props);
  };
  h.settle = async () => { for (let n = 0; n < 30; n++) { await new Promise(r => setImmediate(r)); h.root.flush(); } };
  h.button = prefix => nodes(h.root.element).find(n => n.type === 'Button' && n.props.title.startsWith(prefix))?.props;
  h.prepare = async () => {
    h.mount(); await h.settle();
    nodes(h.root.element).find(n => n.type === 'Field').props.onChangeText('Court');
    nodes(h.root.element).find(n => n.type === 'Toggle').props.onChange(true);
    h.root.flush();
    for (let i = 0; i < 2; i++) {
      nodes(h.root.element).filter(n => n.type === 'TextInput' && n.props.placeholder?.startsWith('Team'))[i].props.onChangeText(`Team ${i}`);
      nodes(h.root.element).filter(n => n.type === 'TextInput' && n.props.placeholder === 'Add player')[i].props.onChangeText(`Player ${i}`);
      h.root.flush();
      nodes(h.root.element).filter(n => n.type === 'Button' && n.props.title === '+')[i].props.onPress();
      h.root.flush();
    }
    h.button('Next:').onPress(); await h.settle();
  };
  return h;
}

(async () => {
  const delayed = harness(); let release;
  delayed.wait = new Promise(r => { release = r; });
  await delayed.prepare();
  assert.equal(delayed.routes.length, 0, 'must not expose lineups before setup response');
  assert.equal(delayed.actions.length, 0, 'no optimistic game or game outbox entry');
  assert.equal(delayed.button('Saving').disabled, true);
  release(); await delayed.settle();
  assert.equal(delayed.routes[0][0], 'SelectLineup');
  assert.equal(delayed.actions[0].t, 'REC_SETUP_CONFIRMED');
  assert.equal(delayed.state.leagues[0].teams.length, 2);
  delayed.root.unmount();

  const failed = harness(); failed.failure = 400;
  await failed.prepare();
  assert.equal(failed.routes.length, 0);
  assert.equal(failed.state.leagues.length, 0);
  assert.equal(failed.calls.length, 1);
  assert.ok(failed.button('Retry'));
  const draft = await failed.service.loadRecSetup('u1');
  assert.ok(draft);
  assert.equal(await failed.service.loadRecSetup('u2'), null);
  failed.root.unmount(); failed.failure = null; failed.mount(); await failed.settle();
  failed.button('Retry').onPress(); failed.button('Retry').onPress(); await failed.settle();
  assert.equal(failed.routes.length, 1);
  assert.deepEqual(failed.calls[0], failed.calls[1]);
  assert.equal(failed.receipts.size, 1);
  assert.equal(failed.disk.size, 0);
  // Replay of the acknowledged bundle must preserve later edits and lineups.
  failed.state.leagues[0].games[0].homeOnCourt = ['later-lineup'];
  failed.state.leagues[0].teams[0].name = 'Edited';
  const replay = reducer(failed.state, { t: 'REC_SETUP_CONFIRMED', bundle: draft.bundle });
  assert.equal(replay.leagues[0].games.length, 1);
  assert.equal(replay.leagues[0].teams[0].name, 'Edited');
  assert.equal(replay.leagues[0].games[0].homeOnCourt[0], 'later-lineup');
  failed.root.unmount();

  const lost = harness(); lost.loseReply = true; await lost.prepare();
  assert.equal(lost.calls.length, 2);
  assert.equal(lost.receipts.size, 1);
  assert.equal(lost.routes.length, 1);
  assert.deepEqual(lost.calls[0], lost.calls[1]);
  lost.root.unmount();
  const offline = harness(); offline.failure = 0; await offline.prepare();
  assert.equal(offline.calls.length, 2); assert.equal(offline.routes.length, 0);
  assert.ok(await offline.service.loadRecSetup('u1')); offline.root.unmount();
  const unread = harness(); unread.readFails = true; await unread.prepare();
  assert.equal(unread.receipts.size, 1); assert.equal(unread.actions.length, 0);
  assert.equal(unread.routes.length, 0); assert.ok(unread.button('Retry'));
  unread.readFails = false; unread.button('Retry').onPress(); await unread.settle();
  assert.equal(unread.routes.length, 1); assert.equal(unread.receipts.size, 1); unread.root.unmount();
  const disk = harness(); disk.storageFails = true; await disk.prepare();
  assert.equal(disk.calls.length, 0); assert.equal(disk.routes.length, 0); disk.root.unmount();
  const local = harness(); local.synced = false; await local.prepare();
  assert.equal(local.actions[0].t, 'REC_SETUP_GAME');
  assert.equal(local.routes.length, 1); assert.equal(local.calls.length, 0); local.root.unmount();
  const missingTeam = harness(); missingTeam.readMissingTeam = true; await missingTeam.prepare();
  assert.equal(missingTeam.routes.length, 0, 'missing team must not enter lineup selection');
  assert.equal(missingTeam.actions.length, 0); missingTeam.root.unmount();
  const finished = harness(); finished.readFinal = true; await finished.prepare();
  assert.equal(finished.routes[0][0], 'FinalScore', 'a previously completed game must not restart lineups'); finished.root.unmount();
  const left = harness(); let respond;
  left.wait = new Promise(r => { respond = r; }); await left.prepare();
  left.root.unmount(); respond(); await left.settle();
  assert.equal(left.routes.length, 0); assert.equal(left.actions.length, 0);
  assert.ok(await left.service.loadRecSetup('u1'), 'unmounted screen keeps recoverable draft');
  left.actor = 'u2';
  const count = left.calls.length;
  assert.equal(await left.service.saveRecSetup({ auth: { getSession: async () => ({ data: { session: { user: { id: 'u2' } } } }) } }, await left.service.loadRecSetup('u1')), false);
  assert.equal(left.calls.length, count);
  console.log('PASS: drop-in setup gates lineups, retains refused drafts across restart, retries once after lost response, and preserves local-only behavior and later edits.');
})().catch(e => { console.error(e); process.exitCode = 1; });
