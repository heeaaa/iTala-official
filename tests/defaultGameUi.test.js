'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const Hooks = require('./harness/pkg/react-live');

function load(file, imports = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText, { exports, setTimeout: () => 1, clearTimeout() {}, require: name => {
    assert.ok(name in imports, `Missing import ${name}`); return imports[name];
  } });
  return exports;
}
function nodes(node) {
  if (!node || typeof node !== 'object') return [];
  return Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
}
const theme = load('src/theme.ts');
const format = load('src/lib/format.ts');
const stats = load('src/lib/stats.ts', { './format': format, '../theme': theme });
let league;
const actions = [], alerts = [], routes = [];
const navigation = { setOptions() {}, addListener: () => () => {}, replace: (...args) => routes.push(args) };
const rn = { ...Object.fromEntries(['View', 'Text', 'Pressable', 'ScrollView', 'FlatList', 'Modal',
  'TextInput', 'ActivityIndicator', 'KeyboardAvoidingView'].map(name => [name, name])),
  Platform: { OS: 'ios' }, Alert: { alert: (...args) => alerts.push(args) },
  AccessibilityInfo: { announceForAccessibility() {} } };
const ui = Object.fromEntries(['Screen', 'Txt', 'Button', 'Card', 'Segmented', 'TeamBadge', 'LivePip',
  'PromoStrip', 'SyncChip'].map(name => [name, name]));
const imports = {
  react: Hooks, 'react-native': rn, '../components/ui': ui, '../theme': theme,
  '../lib/stats': stats, '../lib/liveInput': load('src/lib/liveInput.ts'),
  '../store/StoreProvider': { useLeague: () => league, useStore: () => ({
    dispatch: action => actions.push(action), noteLeagueOpened() {}, loadLeagueDetail: async () => true,
    sync: { phase: 'synced', tone: 'good' },
  }) },
  '../store/AdminProvider': { useAdmin: () => ({ canScoreGame: () => true }) },
  'expo-keep-awake': { useKeepAwake() {} }, '../components/PlayLog': {},
  '../components/FinishLevelModal': { default: 'FinishLevelModal' },
  '../components/DefaultResultModal': { default: 'DefaultResultModal' },
  '../lib/haptics': { successFeedback() {} },
  '../lib/usePromos': { usePromos: () => ({ activePromos: [] }) },
  '../sync/connectSchedule': { canStartFreeformGame: async () => true },
};
const Live = load('src/screens/LiveGameScreen.tsx', imports).default;
const Lineup = load('src/screens/SelectLineupScreen.tsx', imports).default;
function seed(home = 0, away = 0, kind = 'league', period = 1) {
  actions.length = alerts.length = routes.length = 0;
  league = { id: 'l', kind, detailLoaded: true, name: 'Test league', players: [],
    teams: ['h', 'a'].map(id => ({ id, name: `Team ${id}`, playerIds: [], teamOnly: true })),
    games: [{ id: 'g', status: 'live', homeTeamId: 'h', awayTeamId: 'a', period, homeOnCourt: [], awayOnCourt: [] }],
    events: [['h', home], ['a', away]].flatMap(([teamId, count]) => Array.from({ length: count }, (_, index) =>
      ({ id: `${teamId}${index}`, gameId: 'g', teamId, playerId: null, type: 'ft_make', period: 1 }))),
  };
}
const renderLive = spectator => Hooks.render(Live, { route: { params: { leagueId: 'l', gameId: 'g', spectator } }, navigation });
const finish = root => { nodes(root.element).find(node => node.props?.title === 'FINISH GAME').props.onPress(); root.flush(); };
const dialog = root => nodes(root.element).find(node => node.type === 'FinishLevelModal');

seed();
let root = Hooks.render(Lineup, { route: { params: { leagueId: 'l', gameId: 'g' } }, navigation });
const lineupAction = nodes(root.element).find(node => node.props?.title === 'Default/Forfeit');
assert.ok(lineupAction, 'Tip Off uses the requested label');
lineupAction.props.onPress(); root.flush();
assert.ok(nodes(root.element).some(node => node.type === 'DefaultResultModal'));
root.unmount();

for (const [home, away, kind, allowed] of [[0, 0, 'league', true], [10, 10, 'league', false], [0, 0, 'recreational', false]]) {
  seed(home, away, kind); root = renderLive();
  assert.ok(!nodes(root.element).some(node => node.props?.title === 'Default/Forfeit'), 'the tracker has no standalone default action');
  finish(root);
  assert.ok(dialog(root));
  assert.equal(typeof dialog(root).props.onDefaultConfirm === 'function', allowed);
  dialog(root).props.onCancel(); root.flush();
  assert.equal(dialog(root), undefined);
  assert.equal(actions.length, 0, 'cancelling does not save a result');
  root.unmount();
}

seed(); root = renderLive(); finish(root);
dialog(root).props.onDefaultConfirm('a', 30);
assert.equal(actions[0].defaultResult.winnerTeamId, 'a');
assert.equal(actions[0].defaultResult.score, 30);
assert.equal(actions[0].status, 'final');
assert.equal(routes[0][0], 'FinalScore');
root.unmount();

seed(); root = renderLive(); finish(root);
const confirmDefault = dialog(root).props.onDefaultConfirm;
league = { ...league, events: [{ id: 'changed', gameId: 'g', teamId: 'h', playerId: null, type: 'fg2_make', period: 1 }] };
root.invalidate(); root.flush(); confirmDefault('a', 30); root.flush();
assert.equal(actions.length, 0, 'a score arriving while the form is open prevents a default');
assert.equal(alerts[0][0], 'Score changed');
root.unmount();

seed(10, 10); root = renderLive(); finish(root);
dialog(root).props.onAddPeriod(); root.flush();
assert.equal(actions[0].t, 'SET_PERIOD'); assert.equal(actions[0].period, 2);
assert.equal(dialog(root), undefined);
root.unmount();

seed(10, 10, 'league', theme.MAX_PERIOD); root = renderLive(); finish(root);
assert.equal(dialog(root).props.onAddPeriod, undefined);
dialog(root).props.onFinish();
assert.equal(actions[0].status, 'final'); assert.equal(actions[0].defaultResult, undefined);
root.unmount();

seed(10, 9); root = renderLive(); finish(root);
assert.equal(dialog(root), undefined); assert.equal(alerts[0][0], 'Finish game?');
root.unmount();
seed(); root = renderLive(true);
assert.ok(!nodes(root.element).some(node => node.props?.title === 'FINISH GAME'));
root.unmount();

const { DefaultResultForm } = load('src/components/DefaultResultModal.tsx', {
  react: Hooks, 'react-native': rn, './ui': ui, '../theme': theme,
});
const FinishLevelModal = load('src/components/FinishLevelModal.tsx', {
  react: Hooks, 'react-native': rn, './ui': ui, '../theme': theme,
  './DefaultResultModal': { DefaultResultForm: 'DefaultResultForm' },
}).default;
seed();
const modalProps = { home: league.teams[0], away: league.teams[1], score: 0, period: 1,
  onCancel() {}, onFinish() {}, onAddPeriod() {}, onDefaultConfirm() {} };
root = Hooks.render(FinishLevelModal, modalProps);
assert.ok(nodes(root.element).some(node => node.type === 'ScrollView'), 'all actions can scroll on a short screen');
assert.ok(root.element.props.supportedOrientations.includes('landscape'));
nodes(root.element).find(node => node.props?.title === 'Default/Forfeit').props.onPress(); root.flush();
assert.ok(nodes(root.element).some(node => node.type === 'DefaultResultForm'), 'the default form opens inside the same native modal');
root.element.props.onRequestClose(); root.flush();
assert.ok(nodes(root.element).some(node => node.props?.title === 'Default/Forfeit'), 'back returns to the finish choices');
root.unmount();

let confirmed;
root = Hooks.render(DefaultResultForm, { home: league.teams[0], away: league.teams[1], onCancel() {},
  onConfirm: (...args) => { confirmed = args; } });
const confirm = () => nodes(root.element).find(node => node.props?.title === 'Confirm default');
assert.equal(confirm().props.disabled, true);
nodes(root.element).find(node => node.props?.accessibilityRole === 'radio').props.onPress(); root.flush();
nodes(root.element).find(node => node.type === 'TextInput').props.onChangeText('0'); root.flush();
assert.equal(confirm().props.disabled, true);
nodes(root.element).find(node => node.type === 'TextInput').props.onChangeText('25'); root.flush();
assert.equal(confirm().props.disabled, false); confirm().props.onPress();
assert.deepEqual(confirmed, ['h', 25]);
root.unmount();
console.log('✓ default UI: Tip Off label; hidden tracker action; 0–0 eligibility; scored ties; overtime; finalization; spectator access; score-change guard; modal navigation and result validation');
