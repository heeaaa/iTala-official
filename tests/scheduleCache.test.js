'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const Hooks = require('./harness/pkg/react-live');

const source = ts.transpileModule(fs.readFileSync('src/sync/connectScheduleCache.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
const disk = new Map();
const clock = { now: 1000000 };
const storage = {
  getItem: async key => disk.get(key) ?? null,
  setItem: async (key, value) => { disk.set(key, value); },
};
function load() {
  const exports = {};
  class ClockDate extends Date { static now() { return clock.now; } }
  vm.runInNewContext(source, { exports, require: name => {
    assert.equal(name, '@react-native-async-storage/async-storage');
    return { default: storage };
  }, Date: ClockDate, Map, Set, Promise, JSON, Object, Number });
  return exports;
}
const settle = () => new Promise(resolve => setImmediate(resolve));

function nodes(node) {
  if (!node || typeof node !== 'object') return [];
  return Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
}
function textContent(node) {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  return Array.isArray(node) ? node.map(textContent).join('') : textContent(node.props?.children);
}
function screenModule(cache, transport, linking = {}) {
  const listeners = new Set();
  const appState = { currentState: 'active', addEventListener: (_, listener) => {
    listeners.add(listener); return { remove: () => listeners.delete(listener) };
  } };
  const imports = {
    react: Hooks,
    'react-native': { AppState: appState, Linking: linking, ...Object.fromEntries(
      ['ActivityIndicator', 'Pressable', 'ScrollView', 'View'].map(name => [name, name])) },
    '../components/ui': Object.fromEntries(['Button', 'Card', 'Empty', 'Txt'].map(name => [name, name])),
    '../theme': { colors: {}, radius: {}, space: value => value * 4 },
    '../sync/connectScheduleCache': cache,
    '../sync/connectSchedule': {
      ...transport, nextScheduleDay: games => games.find(game => game.day)?.day ?? null,
      nowInZone: () => '2026-10-01T12:00', isConnectResult: () => false,
      connectMobileGameId: id => `cg_${id}`,
    },
  };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/screens/ScheduleTab.tsx', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText, { exports, require: name => {
    assert.ok(name in imports, `Missing import ${name}`); return imports[name];
  }, Intl, Date });
  return { Screen: exports.default, emit: state => listeners.forEach(listener => listener(state)) };
}

(async () => {
  const cache = load();
  const eventA = { id: 'a', name: 'Event A', timezone: 'Pacific/Auckland', divisions: [] };
  const eventB = { ...eventA, id: 'b', name: 'Event B' };
  const scheduleA = { event: { id: 'a', name: 'Event A', timezone: 'Pacific/Auckland', courtNames: [] }, divisions: [], teams: [], games: [] };
  const scheduleB = { ...scheduleA, event: { ...scheduleA.event, id: 'b' } };

  assert.equal(await cache.readConnectScheduleCache('league-1'), null);
  cache.saveConnectScheduleCache('league-1', [eventA, eventB], scheduleA);
  assert.equal(cache.peekConnectScheduleCache('league-1').schedules.a.value.event.id, 'a');
  assert.equal(cache.isConnectScheduleCacheFresh(cache.peekConnectScheduleCache('league-1'), 'a'), true);
  assert.equal(cache.isConnectScheduleCacheFresh(cache.peekConnectScheduleCache('league-1'), 'b'), false);
  await settle();

  const relaunched = load();
  const persisted = await relaunched.readConnectScheduleCache('league-1');
  assert.equal(persisted.schedules.a.value.event.id, 'a', 'a cold launch restores the schedule from disk');
  assert.equal(relaunched.isConnectScheduleCacheFresh(persisted, 'a'), true);
  assert.equal(await relaunched.readConnectScheduleCache('league-2'), null, 'leagues have separate cache keys');

  relaunched.saveConnectScheduleCache('league-1', [eventA, eventB], scheduleB);
  assert.equal(relaunched.peekConnectScheduleCache('league-1').schedules.a.value.event.id, 'a', 'switching events retains the first schedule');
  assert.equal(relaunched.peekConnectScheduleCache('league-1').schedules.b.value.event.id, 'b');
  clock.now += 5 * 60 * 1000;
  assert.equal(relaunched.isConnectScheduleCacheFresh(relaunched.peekConnectScheduleCache('league-1'), 'b'), false,
    'a stale schedule must be refreshed');
  relaunched.saveConnectScheduleCache('league-1', [eventB]);
  assert.equal(relaunched.peekConnectScheduleCache('league-1').schedules.a, undefined,
    'unlinked events must not leave old schedules visible');
  assert.equal(relaunched.isConnectScheduleCacheFresh(relaunched.peekConnectScheduleCache('league-1'), 'b'), false,
    'updating the event list does not make an old schedule fresh');

  disk.set('itala.connect.schedule.v1.corrupt', JSON.stringify({ events: [eventA], eventsUpdatedAt: clock.now,
    schedules: { a: { value: {}, updatedAt: clock.now } } }));
  assert.equal(await load().readConnectScheduleCache('corrupt'), null, 'a malformed saved schedule is a cache miss');

  const screenCache = load();
  let lists = 0, schedules = 0, offline = false;
  let release;
  const displayedSchedule = { ...scheduleA, games: [{ id: 'game-1', day: '2026-10-04', time: '10:00',
    score1: null, score2: null, label: '', homeTeamId: null, awayTeamId: null }] };
  const transport = {
    listConnectEvents: async () => { lists++; if (offline) throw Error('Offline refresh'); return [eventA, eventB]; },
    getConnectSchedule: async (_, eventId) => {
      schedules++;
      if (release) await new Promise(resolve => { release = resolve; });
      return { ...displayedSchedule, event: { ...displayedSchedule.event, id: eventId } };
    },
  };
  const module = screenModule(screenCache, transport);
  const props = { league: { id: 'screen-league', teams: [], games: [] }, canScore: false,
    canManageConnect: false, refreshKey: 0, navigation: {} };
  let root = Hooks.render(module.Screen, props);
  assert.ok(nodes(root.element).some(node => node.type === 'ActivityIndicator'));
  await settle(); root.flush();
  assert.equal(lists, 1); assert.equal(schedules, 1);
  assert.ok(!nodes(root.element).some(node => node.type === 'ActivityIndicator'));
  assert.ok(nodes(root.element).some(node => node.type === 'Card'));
  root.unmount();

  root = Hooks.render(module.Screen, props);
  assert.ok(!nodes(root.element).some(node => node.type === 'ActivityIndicator'), 'tab return displays the cache on its first render');
  assert.ok(nodes(root.element).some(node => node.type === 'Card'), 'the saved date is selected immediately');
  await settle(); root.flush();
  assert.equal(lists, 1, 'returning to a fresh tab must not fetch again');
  assert.equal(schedules, 1);

  nodes(root.element).find(node => node.props?.label === 'Event B').props.onPress();
  await settle(); root.flush();
  assert.equal(schedules, 2, 'an uncached event is fetched');
  nodes(root.element).find(node => node.props?.label === 'Event A').props.onPress();
  await settle(); root.flush();
  assert.equal(schedules, 2, 'switching back to a cached event avoids a fetch');

  release = true;
  nodes(root.element).find(node => node.props?.accessibilityLabel === 'Refresh schedule').props.onPress();
  await settle(); root.flush();
  assert.ok(nodes(root.element).some(node => node.type === 'Card'), 'a pending refresh keeps the saved games visible');
  assert.ok(!nodes(root.element).some(node => node.type === 'ActivityIndicator'));
  release(); release = undefined;
  await settle(); root.flush();

  const beforeForeground = schedules;
  module.emit('background'); module.emit('active');
  await settle(); root.flush();
  assert.equal(schedules, beforeForeground + 1, 'foregrounding refreshes even a fresh cache');
  const beforeKey = schedules;
  root.props = { ...props, refreshKey: 1 }; root.invalidate(); root.flush();
  await settle(); root.flush();
  assert.equal(schedules, beforeKey + 1, 'the scheduled-game redirect forces a refresh');
  root.unmount();

  const cold = screenModule(load(), transport);
  const beforeCold = schedules;
  root = Hooks.render(cold.Screen, props);
  await settle(); root.flush();
  assert.equal(schedules, beforeCold, 'a cold launch uses a fresh disk cache');
  assert.ok(nodes(root.element).some(node => node.type === 'Card'));
  root.unmount();

  clock.now += 5 * 60 * 1000;
  offline = true;
  root = Hooks.render(module.Screen, props);
  await settle(); root.flush();
  assert.ok(nodes(root.element).some(node => node.type === 'Card'), 'offline refresh preserves the schedule');
  assert.ok(nodes(root.element).some(node => node.props?.children === 'Offline refresh'), 'the failed refresh remains visible');
  root.unmount();

  const unlinkedCache = load();
  const unlinkedId = 'unlinked / league';
  unlinkedCache.saveConnectScheduleCache(unlinkedId, []);
  let emptyLists = 0, published = false, failLink = false;
  const opened = [];
  const siteUrl = 'https://itala-connect.example';
  const unlinked = screenModule(unlinkedCache, {
    CONNECT_SITE_URL: siteUrl,
    connectAdminImportUrl: id => `${siteUrl}/admin/import/${encodeURIComponent(id)}`,
    listConnectEvents: async () => { emptyLists++; return published ? [eventA] : []; },
    getConnectSchedule: async () => displayedSchedule,
  }, { openURL: async url => { if (failLink) throw Error('Browser unavailable'); opened.push(url); } });
  const unlinkedProps = { ...props, league: { ...props.league, id: unlinkedId } };
  const message = 'This league has no published iTala Connect schedule yet. You can still start games as usual.';
  function checkUnlinked(root, owner) {
    const all = nodes(root.element);
    assert.equal(textContent(root.element.props.children[0]), message, 'the league status is the first message');
    assert.ok(textContent(root.element).indexOf(message) < textContent(root.element).indexOf('Plan your league'),
      'the Connect CTA follows the status');
    assert.ok(!/fixture/i.test(textContent(root.element)), 'the empty state uses schedule terminology');
    const buttons = all.filter(node => node.type === 'Button');
    assert.deepEqual(buttons.map(node => node.props.title), owner ? ['Link this league in Connect'] : [],
      'website and refresh actions never appear as large buttons');
    const website = all.find(node => node.props?.accessibilityLabel === 'Open iTala Connect website');
    const refresh = all.find(node => node.props?.accessibilityLabel === 'Refresh schedule');
    assert.equal(website.props.accessibilityRole, 'link');
    assert.equal(refresh.props.accessibilityRole, 'button');
    assert.ok(root.element.props.style.maxWidth >= 320, 'the tablet column allows a phone width');
    assert.equal(root.element.props.style.width, '100%', 'the column adapts to its available width');
    for (const action of [website, refresh]) {
      assert.ok(action.props.style({ pressed: false }).minHeight >= 44, 'quiet actions keep accessible touch targets');
      const label = nodes(action).find(node => node.type === 'Txt');
      assert.equal(label.props.style.textDecorationLine, 'underline', 'text actions remain visibly discoverable');
      assert.equal(label.props.numberOfLines, undefined, 'link text can wrap on compact screens and with larger text');
    }
    return { website, refresh, buttons };
  }
  root = Hooks.render(unlinked.Screen, unlinkedProps);
  await settle(); root.flush();
  assert.equal(emptyLists, 0, 'a fresh empty cache avoids a redundant request');
  let actions = checkUnlinked(root, false);
  actions.website.props.onPress(); await settle(); root.flush();
  assert.equal(opened.at(-1), siteUrl, 'the website link opens Connect');
  failLink = true;
  actions.website.props.onPress(); await settle(); root.flush();
  assert.ok(textContent(root.element).includes('Could not open iTala Connect'), 'browser errors are shown');
  failLink = false;
  actions.website.props.onPress(); await settle(); root.flush();
  assert.ok(!textContent(root.element).includes('Could not open iTala Connect'), 'retry clears the browser error');
  actions.refresh.props.onPress(); await settle(); root.flush();
  assert.equal(emptyLists, 1, 'the footnote refresh bypasses a fresh empty cache');
  checkUnlinked(root, false);
  root.unmount();

  root = Hooks.render(unlinked.Screen, { ...unlinkedProps, canManageConnect: true });
  await settle(); root.flush();
  actions = checkUnlinked(root, true);
  actions.buttons[0].props.onPress(); await settle(); root.flush();
  assert.equal(opened.at(-1), `${siteUrl}/admin/import/${encodeURIComponent(unlinkedId)}`,
    'the owner CTA opens the import page for this league');
  published = true;
  actions.refresh.props.onPress(); await settle(); root.flush();
  assert.equal(emptyLists, 2);
  assert.ok(!textContent(root.element).includes(message), 'refresh replaces the empty state when a schedule is published');
  assert.ok(textContent(root.element).includes('Times in Pacific/Auckland'));
  root.unmount();

  console.log('✓ schedule cache and tab: fetch, remount, disk restore, event switching, refresh, expiry, offline fallback, league isolation, and unlinked owner/guest actions');
})().catch(error => { console.error(error); process.exitCode = 1; });
