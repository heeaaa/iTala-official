// Executes the actual importer screen, draft storage and submission service.
// The hook runtime does not simulate native rendering or navigation gestures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const HookRuntime = require('./harness/pkg/react-live');
const { FakeServer, makeClient } = require('./harness/fakeSupabase');

function harness({ shortTimeout = false, development = true } = {}) {
  const disk = new Map(), cache = new Map();
  const server = new FakeServer();
  server.rows.leagues.push({ id: 'league', name: 'Sunday Run' });
  const sb = makeClient(server);
  const h = { actor: 'u1', disk, server, sb, back: 0, alerts: [], storageFails: false, refreshFails: false, refreshStalls: false, synced: true, localWrites: [] };
  h.diagnostics = [];
  h.nativeListeners = new Set();
  sb.auth = { getSession: async () => ({ data: { session: { user: { id: h.actor } } }, error: null }) };
  const storage = {
    getItem: async k => disk.get(k) ?? null,
    setItem: async (k, v) => { if (h.storageFails) throw new Error('disk full'); disk.set(k, v); },
    removeItem: async k => { if (h.storageFails) throw new Error('disk full'); disk.delete(k); },
    getAllKeys: async () => [...disk.keys()],
    multiRemove: async keys => { keys.forEach(k => disk.delete(k)); },
  };
  let uid = 0;
  function load(file) {
    const absolute = path.resolve(__dirname, '..', file);
    if (cache.has(absolute)) return cache.get(absolute);
    const exports = {};
    cache.set(absolute, exports);
    const requireModule = name => {
      if (name === 'react') return HookRuntime;
      if (name === '@react-navigation/elements') return { useHeaderHeight: () => 96 };
      if (name === 'react-native') return { Platform: { OS: 'ios' },
        DeviceEventEmitter: { addListener: (_name, listener) => { h.nativeListeners.add(listener); return { remove: () => h.nativeListeners.delete(listener) }; } },
        View: 'View', ScrollView: 'ScrollView', TextInput: 'TextInput', Pressable: 'Pressable', Alert: { alert: (...args) => h.alerts.push(args) } };
      if (name === '@react-native-async-storage/async-storage') return { default: storage };
      if (name.endsWith('/components/ui')) return { Screen: 'Screen', Txt: 'Txt', Button: 'Button', Card: 'Card' };
      if (name.endsWith('/store/StoreProvider')) return {
        useStore: () => ({ synced: h.synced, dispatch: action => h.localWrites.push(action), loadLeagueDetail: () => h.refreshStalls ? new Promise(() => {}) : Promise.resolve(!h.refreshFails) }),
        useLeague: () => ({ id: 'league', name: 'Sunday Run', teams: [], players: [] }),
      };
      if (name.endsWith('/store/AdminProvider')) return { useAdmin: () => ({ user: h.actor ? { id: h.actor } : null }) };
      if (name.endsWith('/sync/supabase')) return { getSupabase: () => sb };
      if (name.endsWith('/lib/log')) return { isDevBuild: () => development, devLog: (_tag, data) => h.diagnostics.push(JSON.parse(data)) };
      if (name.endsWith('/theme')) return { colors: {}, space: x => x, radius: {}, font: {}, teamColors: ['#12D7D0'] };
      if (name.endsWith('/lib/format')) return { uid: () => `id-${++uid}` };
      if (name.startsWith('.')) {
        const target = path.resolve(path.dirname(absolute), name);
        return load(fs.existsSync(target + '.ts') ? target + '.ts' : target + '.tsx');
      }
      throw new Error(`Unexpected import ${name}`);
    };
    const source = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
    }).outputText;
    vm.runInNewContext(source, { exports, require: requireModule,
      setTimeout: (fn, ms) => setTimeout(fn, shortTimeout && ms === 15000 ? 1 : ms),
      clearTimeout, AbortController, console }, { filename: absolute });
    return exports;
  }
  h.drafts = load('src/store/rosterDraft.ts');
  h.service = load('src/sync/rosterImport.ts');
  h.queue = load('src/sync/pushQueue.ts');
  const screen = load('src/screens/BulkImportScreen.tsx').default;
  h.mount = () => {
    const outer = HookRuntime.render(screen, { route: { params: { leagueId: 'league' } }, navigation: { goBack: () => h.back++ } });
    const editor = outer.element;
    outer.unmount();
    h.root = HookRuntime.render(editor.type, editor.props);
    return h.root;
  };
  h.settle = async () => {
    for (let n = 0; n < 40; n++) { await new Promise(resolve => setImmediate(resolve)); h.root?.flush(); }
  };
  function nodes(node, result = []) {
    if (!node || typeof node !== 'object') return result;
    if (Array.isArray(node)) { node.forEach(child => nodes(child, result)); return result; }
    result.push(node); nodes(node.props?.children, result); return result;
  }
  h.button = title => nodes(h.root.element).find(n => n.type === 'Button' && n.props.title === title)?.props;
  h.text = () => JSON.stringify(h.root.element);
  h.review = async () => {
    h.mount(); await h.settle();
    assert.equal(h.root.element.props.keyboardVerticalOffset, 96);
    const scroll = nodes(h.root.element).find(n => n.type === 'ScrollView');
    assert.equal(scroll.props.style.flex, 1);
    assert.ok(!nodes(scroll).some(n => n.type === 'Button' && n.props.title === 'Preview'),
      'Preview stays outside the scrolling roster field in the keyboard-adjusted footer');
    const input = nodes(h.root.element).find(n => n.type === 'TextInput' && n.props.multiline);
    input.props.onChangeText('Alpha\nAlex #09\nJamie #17\nPat #11\nSam #22\nDrew #44\n\nBeta\nBob #22\nTaylor #1\nCasey #5\nMorgan #4\nRiley #7');
    await h.settle();
    h.button('Preview').onPress(); await h.settle();
    h.button('Create 2 teams & 10 players').onPress();
    h.alerts.at(-1)[2].find(b => b.text === 'Create').onPress();
    await h.settle();
  };
  return h;
}

(async () => {
  // Original bug: reject just the bulk request while all reads still work.
  const h = harness();
  h.server.failures['rpc:bulk_import_roster_once'] = 'network-resolved';
  await h.review();
  assert.equal(h.back, 0);
  assert.equal(h.server.log.filter(x => x.name === 'bulk_import_roster_once').length, 2, 'at most one automatic retry');
  assert.ok(h.button('Retry import'));
  assert.equal(h.localWrites.length, 0);
  const saved = await h.drafts.loadRosterDraft('u1', 'league');
  assert.equal(saved.operation.teams.length, 2);
  assert.equal(saved.operation.teams[0].players[0].number, '09');
  assert.equal(await h.drafts.loadRosterDraft('u2', 'league'), null);
  h.root.unmount(); h.mount(); await h.settle();
  assert.ok(h.button('Retry import'));
  delete h.server.failures['rpc:bulk_import_roster_once'];
  h.button('Retry import').onPress(); h.button('Retry import').onPress();
  await h.settle();
  assert.equal(h.back, 1);
  assert.equal(h.server.count('players'), 10);
  assert.equal(await h.drafts.loadRosterDraft('u1', 'league'), null);
  h.root.unmount();
  console.log('PASS: failed import retains exact draft; restart restores it; double retry saves once and navigates after confirmation.');

  const lost = harness();
  lost.server.failures['after:rpc:bulk_import_roster_once'] = true;
  await lost.review();
  assert.equal(lost.back, 1);
  const lostRequests = lost.server.log.filter(x => x.name === 'bulk_import_roster_once');
  assert.equal(lostRequests.length, 2);
  assert.deepEqual(lostRequests[0].payload, lostRequests[1].payload);
  assert.equal(lost.server.count('teams'), 2);
  assert.equal(lost.server.count('players'), 10);
  lost.root.unmount();
  console.log('PASS: server commit with lost response is recovered from its receipt.');

  for (const switchAccount of [false, true]) {
    const transient = harness();
    const rpc = transient.sb.rpc;
    let sends = 0;
    transient.sb.rpc = (name, args) => {
      sends++;
      if (sends !== 1) return rpc(name, args);
      if (switchAccount) transient.actor = 'u2';
      const first = Promise.resolve({ data: null, error: { message: 'TypeError: Network request failed', code: '' }, status: 0 });
      first.abortSignal = () => first;
      return first;
    };
    await transient.review();
    assert.equal(sends, switchAccount ? 1 : 2);
    assert.equal(transient.back, switchAccount ? 0 : 1);
    assert.equal(transient.server.count('players'), switchAccount ? 0 : 10);
    transient.root.unmount();
  }
  console.log('PASS: transient first failure recovers automatically; account switch prevents the automatic retry.');

  const waiting = harness();
  let answer;
  const original = waiting.sb.rpc;
  waiting.sb.rpc = (name, args) => {
    if (name !== 'bulk_import_roster_once') return original(name, args);
    const response = new Promise(resolve => { answer = () => resolve(original(name, args)); });
    response.abortSignal = () => response;
    return response;
  };
  await waiting.review();
  assert.equal(waiting.back, 0);
  assert.equal(waiting.button('Saving…').disabled, true);
  assert.equal(waiting.nativeListeners.size, 1);
  for (const listener of waiting.nativeListeners) listener([123, 'The network connection was lost. https://private.invalid/?token=secret', false]);
  const native = waiting.diagnostics.find(x => x.phase === 'NATIVE_FAILURE_UNCORRELATED');
  assert.equal(native.category, 'connection-lost');
  assert.equal(native.requestId, 123);
  assert.equal(native.during, 'RPC_START');
  assert.ok(!JSON.stringify(waiting.diagnostics).includes('secret'));
  const inFlightDraft = await waiting.drafts.loadRosterDraft('u1', 'league');
  const unrelatedDraft = JSON.parse(JSON.stringify(inFlightDraft));
  unrelatedDraft.operation.id = 'another-operation';
  assert.equal((await waiting.service.submitRosterImport(waiting.sb, unrelatedDraft)).saved, false);
  assert.deepEqual(await waiting.drafts.loadRosterDraft('u1', 'league'), inFlightDraft,
    'a different concurrent operation must not replace the recoverable draft');
  waiting.root.unmount(); answer(); await waiting.settle();
  assert.equal(waiting.nativeListeners.size, 0, 'native observation must end when the request settles');
  assert.equal(waiting.back, 0);
  assert.ok(await waiting.drafts.loadRosterDraft('u1', 'league'));
  waiting.mount(); await waiting.settle();
  // Restore real RPC to reconcile the completed operation after reopening.
  waiting.sb.rpc = original;
  waiting.button('Retry import').onPress(); await waiting.settle();
  assert.equal(waiting.back, 1);
  assert.equal(waiting.server.count('teams'), 2);
  waiting.root.unmount();
  console.log('PASS: delayed save blocks completion; leaving does not navigate later; reopening reconciles safely.');

  const disk = harness();
  disk.storageFails = true;
  await disk.review();
  assert.equal(disk.server.log.filter(x => x.name === 'bulk_import_roster_once').length, 0);
  assert.equal(disk.back, 0);
  disk.root.unmount();
  console.log('PASS: persistence failure prevents submission.');

  const denied = harness();
  denied.server.failures['rpc:bulk_import_roster_once'] = { code: 'P0001', message: 'Scorekeeper access required.' };
  await denied.review();
  assert.ok(denied.text().includes('did not accept'));
  assert.equal(denied.server.log.filter(x => x.name === 'bulk_import_roster_once').length, 1);
  const operation = await denied.drafts.loadRosterDraft('u1', 'league');
  denied.actor = 'u2';
  const count = denied.server.log.length;
  assert.equal((await denied.service.submitRosterImport(denied.sb, operation)).saved, false);
  assert.equal(denied.server.log.length, count);
  denied.root.unmount();
  console.log('PASS: refusal retains the draft; changed account cannot issue the saved operation.');

  const refresh = harness(); refresh.refreshFails = true;
  await refresh.review();
  assert.equal(refresh.back, 0);
  assert.ok(refresh.text().includes('Your roster is saved'));
  refresh.refreshFails = false;
  refresh.server.rows.players[0].name = 'Edited afterward';
  refresh.button('Retry import').onPress(); await refresh.settle();
  assert.equal(refresh.back, 1);
  assert.equal(refresh.server.rows.players[0].name, 'Edited afterward');
  refresh.root.unmount();
  console.log('PASS: refresh failure retains completion state; retry never overwrites later edits.');

  const local = harness(); local.synced = false;
  await local.review();
  assert.equal(local.back, 1);
  assert.equal(local.localWrites.length, 1);
  assert.equal(local.server.log.length, 0);
  assert.equal(local.disk.size, 0, 'local-only flow must not introduce a second persistence mechanism');
  local.root.unmount();
  console.log('PASS: local-only importer remains local.');

  const timed = harness({ shortTimeout: true });
  timed.sb.auth.getSession = () => new Promise(() => {});
  await timed.review();
  await new Promise(resolve => setTimeout(resolve, 10)); await timed.settle();
  assert.equal(timed.back, 0);
  assert.equal(timed.server.log.length, 0);
  assert.ok(timed.button('Retry import'));
  assert.ok(await timed.drafts.loadRosterDraft('u1', 'league'));
  timed.root.unmount();
  console.log('PASS: stalled session read times out without losing the draft or sending a request.');

  const missing = harness();
  missing.server.failures['rpc:bulk_import_roster_once'] = { code: 'PGRST202', message: 'Missing RPC' };
  await missing.review();
  assert.equal(missing.back, 0);
  assert.ok(missing.text().includes('needs a server update'));
  assert.ok(await missing.drafts.loadRosterDraft('u1', 'league'));
  missing.root.unmount();
  console.log('PASS: older server fails safely with upgrade guidance and retained input.');

  const corrupt = harness();
  await corrupt.drafts.saveRosterDraft({ version: 1, actorId: 'u1', leagueId: 'league', text: '', teams: null, operation: null });
  const draftKey = [...corrupt.disk.keys()][0];
  corrupt.disk.set(draftKey, '{bad-json');
  corrupt.mount(); await corrupt.settle();
  assert.ok(corrupt.text().includes('could not be loaded'));
  assert.equal(corrupt.disk.get(draftKey), '{bad-json');
  corrupt.root.unmount();
  console.log('PASS: corrupted draft is reported without overwriting its stored copy.');

  const changed = harness(); changed.refreshFails = true;
  await changed.review();
  const changedDraft = await changed.drafts.loadRosterDraft('u1', 'league');
  changedDraft.operation.teams[0].players[0].name = 'Different payload';
  assert.equal((await changed.service.submitRosterImport(changed.sb, changedDraft)).saved, false,
    'an old receipt with matching counts must not confirm a rejected changed payload');
  changed.root.unmount();
  console.log('PASS: rejected changed payload cannot borrow an earlier receipt.');

  const stalledRefresh = harness({ shortTimeout: true }); stalledRefresh.refreshStalls = true;
  await stalledRefresh.review();
  await new Promise(resolve => setTimeout(resolve, 20)); await stalledRefresh.settle();
  assert.ok(stalledRefresh.button('Retry import'), 'stalled refresh must return control');
  assert.ok(stalledRefresh.text().includes('Your roster is saved'));
  assert.ok(await stalledRefresh.drafts.loadRosterDraft('u1', 'league'));
  stalledRefresh.root.unmount();
  console.log('PASS: stalled post-save refresh returns control and retains the draft.');

  const cleanup = harness();
  const emptyDraft = { version: 1, actorId: 'u1', leagueId: 'league', text: 'private roster', teams: null, operation: null };
  const queuedWrite = cleanup.drafts.saveRosterDraft(emptyDraft);
  await cleanup.drafts.saveRosterDraft({ ...emptyDraft, actorId: 'u10' });
  cleanup.disk.set('other-app-state', 'preserved');
  await cleanup.drafts.clearAccountRosterDrafts('u1'); await queuedWrite;
  assert.equal(await cleanup.drafts.loadRosterDraft('u1', 'league'), null);
  assert.ok(await cleanup.drafts.loadRosterDraft('u10', 'league'));
  assert.equal(cleanup.disk.get('other-app-state'), 'preserved');
  console.log('PASS: account deletion clears scoped drafts without erasing another account or app state.');

  const queued = harness({ shortTimeout: true });
  let release;
  const blocker = queued.queue.enqueuePush(() => new Promise(resolve => { release = resolve; }));
  await queued.review();
  await new Promise(resolve => setTimeout(resolve, 20)); await queued.settle();
  assert.ok(queued.button('Retry import'));
  assert.ok(await queued.drafts.loadRosterDraft('u1', 'league'));
  assert.equal(queued.server.log.length, 0);
  release(); await blocker; await queued.settle();
  assert.equal(queued.server.log.length, 0, 'expired queued attempt must not send later');
  assert.ok(queued.diagnostics.some(x => x.phase === 'ATTEMPT_WAIT_EXPIRED'));
  assert.ok(!queued.diagnostics.some(x => x.phase === 'RPC_START'));
  assert.equal(queued.back, 0);
  queued.root.unmount();
  console.log('PASS: stalled preceding write returns control without a surprise import when the queue clears.');

  const releaseBuild = harness({ development: false });
  await releaseBuild.review();
  assert.equal(releaseBuild.back, 1);
  assert.equal(releaseBuild.diagnostics.length, 0);
  assert.equal(releaseBuild.nativeListeners.size, 0);
  releaseBuild.root.unmount();
  console.log('PASS: diagnostics classify native errors without secrets, clean up listeners, and remain disabled in release builds.');
})().catch(error => { console.error(error); process.exitCode = 1; });
