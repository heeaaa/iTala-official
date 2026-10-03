'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const Hooks = require('./harness/pkg/react-live');
const settle = () => new Promise(resolve => setImmediate(resolve));
function load(file, imports = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText, { exports, require: name => { assert.ok(name in imports, name); return imports[name]; },
    AbortController, AbortSignal, Date, Intl, Map, Promise, setTimeout, clearTimeout });
  return exports;
}
function nodes(n) {
  if (!n || typeof n !== 'object') return [];
  return Array.isArray(n) ? n.flatMap(nodes) : [n, ...nodes(n.props?.children)];
}
const theme = load('src/theme.ts'), format = load('src/lib/format.ts');
const stats = load('src/lib/stats.ts', { './format': format, '../theme': theme });
let requests = 0;
const connect = load('src/sync/connectSchedule.ts', { './supabase': { SYNC_ENABLED: true,
  getSupabase: () => ({ functions: { invoke: async () => { requests++; return { error: Error('Connect unavailable') }; } } }) } });
const base = { id: 'league', name: 'League', season: '2026', kind: 'league', detailLoaded: true,
  createdAt: 1, connectLink: { events: [], revision: 1, checkedAt: 1 },
  teams: ['home', 'away'].map(id => ({ id, name: id, color: '#123456', playerIds: [], teamOnly: true })),
  players: [], games: [], events: [] };
let league = base;
const actions = [], routes = [], alerts = [];
const imports = {
  react: Hooks, 'react-native': { ...Object.fromEntries(['View', 'ScrollView', 'Pressable', 'TextInput',
    'ActivityIndicator'].map(name => [name, name])), Alert: { alert: (...args) => alerts.push(args) }, Linking: {}, Share: {} },
  '../components/ui': Object.fromEntries(['Screen', 'Txt', 'Card', 'Button', 'Field', 'TeamBadge', 'Pill',
    'Segmented', 'Empty', 'LivePip', 'Toggle', 'ReportAction'].map(name => [name, name])),
  '../store/StoreProvider': { useLeague: () => league, useStore: () => ({ dispatch: action => actions.push(action),
    prefs: { favTeamIds: [] }, loadLeagueDetail: async () => true, noteLeagueOpened() {}, leaguesLoading: [] }) },
  '../store/AdminProvider': { useAdmin: () => ({ canScore: () => true, isOwner: () => true,
    canScoreGame: () => true, user: { id: 'owner' } }) },
  '../theme': theme, '../lib/format': format, '../lib/stats': stats, '../sync/connectSchedule': connect,
  './ScheduleTab': { default: 'ScheduleTab' }, '../components/ConnectLinkSettings': { default: 'ConnectLinkSettings' },
  '../components/DefaultResultModal': { default: 'DefaultResultModal' },
};
const Detail = load('src/screens/LeagueDetailScreen.tsx', imports).default;
const NewGame = load('src/screens/NewGameScreen.tsx', imports).default;
const Lineup = load('src/screens/SelectLineupScreen.tsx', imports).default;
const navigation = { navigate: (...args) => routes.push(args), replace: (...args) => routes.push(args) };
const button = (root, title) => nodes(root.element).find(n => n.props?.title === title);

(async () => {
  for (let n = 0; n < 3; n++) {
    let root = Hooks.render(Detail, { route: { params: { leagueId: league.id } }, navigation });
    button(root, '▶  Start Game').props.onPress(); await settle(); root.flush();
    assert.equal(routes.at(-1)[0], 'NewGame');
    assert.equal(alerts.length, 0, 'ordinary Start Game shows no schedule modal');
    root.unmount();
    root = Hooks.render(NewGame, { route: { params: { leagueId: league.id } }, navigation });
    const teams = nodes(root.element).filter(node => node.type === 'Card');
    teams[0].props.onPress(); root.flush();
    nodes(root.element).filter(node => node.type === 'Card')[1].props.onPress(); root.flush();
    button(root, 'Next: lineups  ▶').props.onPress(); await settle(); root.flush();
    assert.equal(routes.at(-1)[0], 'SelectLineup');
    root.unmount();
    const pending = { homeTeamId: 'home', awayTeamId: 'away' };
    root = Hooks.render(Lineup, { route: { params: { leagueId: league.id, gameId: 'new' + n, pending } }, navigation });
    button(root, 'Tip off  ▶').props.onPress(); await settle(); root.flush();
    assert.equal(routes.at(-1)[0], 'LiveGame');
    assert.ok(actions.some(action => action.t === 'CREATE_GAME' && action.id === 'new' + n));
    root.unmount();
    root = Hooks.render(Lineup, { route: { params: { leagueId: league.id, gameId: 'default' + n, pending } }, navigation });
    button(root, 'Default/Forfeit').props.onPress(); root.flush();
    await nodes(root.element).find(node => node.type === 'DefaultResultModal').props.onConfirm('away', 20);
    assert.equal(routes.at(-1)[0], 'FinalScore');
    assert.ok(actions.some(action => action.id === 'default' + n && action.defaultResult.score === 20));
    root.unmount();
  }
  assert.equal(requests, 0, 'all four ordinary screen actions use the real local policy with zero Connect calls');
  league = { ...base, connectLink: { events: [{ id: 'event', name: 'Event' }], revision: 2, checkedAt: 2 } };
  let root = Hooks.render(Detail, { route: { params: { leagueId: league.id } }, navigation });
  button(root, 'Choose a scheduled game').props.onPress(); root.flush();
  assert.ok(nodes(root.element).some(node => node.type === 'ScheduleTab'));
  assert.equal(requests, 0, 'the linked start action routes to Schedule without discovering links');
  root.unmount();

  let fail = true, received = [];
  const Settings = load('src/components/ConnectLinkSettings.tsx', {
    react: Hooks, 'react-native': imports['react-native'], './ui': imports['../components/ui'], '../theme': theme,
    '../sync/connectSchedule': { refreshConnectLinkState: async () => {
      if (fail) throw Error('Unavailable'); return { events: [], revision: 3, checkedAt: 3 };
    } },
  }).default;
  root = Hooks.render(Settings, { league, onUpdate: state => received.push(state) });
  await settle(); root.flush();
  assert.ok(nodes(root.element).some(node => String(node.props?.children).includes('previous status is unchanged')));
  assert.equal(received.length, 0, 'failed settings discovery never toggles off a link');
  fail = false;
  nodes(root.element).find(node => node.props?.accessibilityLabel === 'Check for a Connect schedule').props.onPress();
  await settle(); root.flush();
  assert.equal(received[0].revision, 3);
  root.unmount();
  console.log('✓ actual mobile screens: repeated Start Game, New Game, Tip Off and Default with unavailable Connect; linked routing and settings failure/retry');
})().catch(error => { console.error(error); process.exitCode = 1; });
