// Runs real screen functions with the existing lightweight React harness.
// Layout checks verify native constraints, not native pixel rendering.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const Hooks = require('./harness/pkg/react-live');
function load(file, imports = {}, suffix = '') {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8') + suffix, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText, { exports, require: name => {
    if (!(name in imports)) throw Error(`Missing import ${name}`);
    return imports[name];
  } });
  return exports;
}
function nodes(n) {
  if (!n || typeof n !== 'object') return [];
  return Array.isArray(n) ? n.flatMap(nodes) : [n, ...nodes(n.props?.children)];
}
const theme = load('src/theme.ts');
const format = load('src/lib/format.ts');
const stats = load('src/lib/stats.ts', { './format': format, '../theme': theme });
let league;
const rn = Object.fromEntries(['View', 'Text', 'Pressable', 'ScrollView', 'ActivityIndicator'].map(x => [x, x]));
rn.StyleSheet = { create: x => x };
const ui = Object.fromEntries(['Screen', 'Txt', 'Card', 'Segmented', 'Button', 'Pill', 'TeamBadge', 'LivePip', 'MiniWordmark', 'SignInModal', 'SponsorMark', 'ReportAction'].map(x => [x, x]));
const imports = {
  react: Hooks, 'react-native': rn, '../theme': theme,
  '../components/ui': ui, '../lib/stats': stats, '../lib/format': format,
  '../store/StoreProvider': { useStore: () => ({ dispatch() {} }), useLeague: () => league },
  '../store/AdminProvider': { useAdmin: () => ({ role: 'owner', errorFor: () => null, canScore: () => true, canScoreGame: () => true }) },
  'react-native-view-shot': {}, 'expo-linear-gradient': { LinearGradient: 'LinearGradient' },
  'expo-sharing': {}, '../components/PlayLog': {},
};
const Box = load('src/screens/BoxScoreScreen.tsx', imports).default;
const Final = load('src/screens/FinalScoreScreen.tsx', {
  ...imports,
  'react-native': { ...rn, Animated: {
    View: 'Animated.View', Value: class { constructor() {} },
    timing() {}, spring() {}, parallel: () => ({ start() {} }),
  } },
  '../lib/usePromos': { usePromos: () => ({ activePromos: [] }) },
}).default;
const { gameCardOptions } = load('src/lib/cardSpecs.ts', {
  './stats': stats, './format': format, '../theme': theme,
});
let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`PASS ${label}`); }
  catch (e) { failures++; console.error(`FAIL ${label}: ${e.message}`); }
}
for (const mode of [{ kind: 'league' }, { kind: 'recreational', isShared: true }, { kind: 'recreational', isShared: false }]) {
  for (const winningSide of ['home', 'away']) {
    const game = { id: 'g', homeTeamId: 'h', awayTeamId: 'a', status: 'final' };
    const winner = winningSide === 'home' ? 'h' : 'a', loser = winner === 'h' ? 'a' : 'h';
    league = { ...mode, id: 'l', name: 'Test', season: 'S1', games: [game],
      teams: ['h', 'a'].map(id => ({ id, name: id === 'h' ? 'BAMBHORATS KNIGHTS' : 'TIGS HANDYMAN AND DOC FRANK', playerIds: [id + '1', id + '2'] })),
      players: ['h1', 'h2', 'a1', 'a2'].map(id => ({ id, name: id })), events: [] };
    function add(teamId, playerId, type, count) {
      for (let i = 0; i < count; i++) league.events.push({ id: String(league.events.length), gameId: 'g', teamId, playerId, type, period: 1 });
    }
    add(winner, winner + '1', 'fg2_make', 6);
    add(winner, winner + '2', 'fg2_make', 5);
    add(winner, winner + '2', 'ast', 10); // best composite, fewer points
    add(loser, loser + '1', 'fg2_make', 10); // highest scorer loses 20–22
    const root = Hooks.render(Box, { route: { params: { leagueId: 'l', gameId: 'g' } }, navigation: {} });
    check(`${JSON.stringify(mode)} ${winningSide} win: share award agrees with winner/composite rating`, () => {
      const panel = nodes(root.element).find(n => n.props?.children?.some?.(c => c?.props?.children === '★ PLAYER OF THE GAME'));
      assert.equal(panel.props.children[1].props.children, winner + '2');
      const final = Hooks.render(Final, { route: { params: { leagueId: 'l', gameId: 'g' } }, navigation: {} });
      const finalPanel = nodes(final.element).find(n => n.props?.children?.some?.(c => c?.props?.children === '🏅 PLAYER OF THE GAME'));
      assert.equal(finalPanel.props.children[1].props.children, panel.props.children[1].props.children);
      final.unmount();
      const awardees = league.players.filter(p => gameCardOptions(league, 'g', p.id).some(c => c.key === 'potg'));
      assert.deepEqual(awardees.map(p => p.id), [winner + '2']);
    });
    check(`${JSON.stringify(mode)} box header keeps each name beside its score`, () => {
      const header = nodes(root.element).find(n => n.type === 'Card');
      for (const team of league.teams) {
        const name = nodes(header).find(n => n.type === 'Txt' && n.props.k === 'h2' && n.props.children === team.name);
        assert.equal(name.props.numberOfLines, 2);
        const row = nodes(header).find(n => n.props?.children?.includes?.(name));
        assert.ok(nodes(row).some(n => n.props?.k === 'statBig'), 'score belongs in same row as team name');
      }
    });
    root.unmount();
    check(`${JSON.stringify(mode)} level game and empty/team-only game`, () => {
      add(loser, loser + '1', 'fg2_make', 1);
      assert.equal(stats.playerOfTheGame(league, game).l.playerId, winner + '2');
      league.events = [];
      assert.equal(stats.playerOfTheGame(league, game), undefined);
      add(winner, null, 'fg2_make', 5);
      add(loser, loser + '1', 'fg2_make', 1);
      assert.equal(stats.playerOfTheGame(league, game), undefined, 'never fall back to the losing team for a team-only winner');
    });
  }
}
// Export private component only in the test VM; production API stays unchanged.
const SideScore = load('src/screens/LiveGameScreen.tsx', {
  ...imports, 'expo-keep-awake': {}, '../lib/liveInput': {}, '../lib/haptics': {}, '../lib/usePromos': {},
}, '\nexport { SideScore };').SideScore;
for (const right of [false, true]) check(`live long name constrained on ${right ? 'right' : 'left'}`, () => {
  const root = Hooks.render(SideScore, { team: league.teams[1], score: 22, teamFouls: 2, timeouts: 0, right });
  const name = nodes(root.element).find(n => n.props?.children === league.teams[1].name);
  assert.equal(name.props.numberOfLines, 2);
  assert.equal(name.props.style.flex, 1);
  assert.equal(root.element.props.style.minWidth, 0);
  root.unmount();
});
const Segmented = load('src/components/ui.tsx', {
  react: Hooks, 'react-native': rn, '../theme': theme,
  'react-native-gesture-handler': {}, 'react-native-safe-area-context': {},
  'expo-linear-gradient': imports['expo-linear-gradient'],
  '../../assets/sponsor-bpbl-clothing-inverse.png': 1, '../../assets/sponsor-bpbl-clothing.png': 2,
}).Segmented;
check('team tabs center both labels and stretch both backgrounds equally', () => {
  const root = Hooks.render(Segmented, { options: ['SAMARITANS', 'TIGS HANDYMAN AND DOC FRANK'], value: 0, onChange() {} });
  for (const label of nodes(root.element).filter(n => n.type === 'Text')) {
    assert.equal(label.props.numberOfLines, 2);
    assert.equal(label.props.style.textAlign, 'center');
  }
  for (const tab of nodes(root.element).filter(n => n.type === 'Pressable')) assert.equal(tab.props.children.props.style.flex, 1);
  root.unmount();
});
process.exitCode = failures ? 1 : 0;
