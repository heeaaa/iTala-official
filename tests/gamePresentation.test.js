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
const rn = Object.fromEntries(['View', 'Text', 'Pressable', 'ScrollView', 'ActivityIndicator', 'TouchableOpacity'].map(x => [x, x]));
rn.StyleSheet = { create: x => x };
rn.Platform = { OS: 'ios' };
const ui = Object.fromEntries(['Screen', 'Txt', 'Card', 'Segmented', 'Button', 'Pill', 'TeamBadge', 'LivePip', 'MiniWordmark', 'SignInModal', 'SponsorMark', 'ReportAction'].map(x => [x, x]));
const imports = {
  react: Hooks, 'react-native': rn, '../theme': theme,
  '../components/ui': ui, '../lib/stats': stats, '../lib/format': format,
  '../store/StoreProvider': { useStore: () => ({ dispatch() {} }), useLeague: () => league },
  '../store/AdminProvider': { useAdmin: () => ({ role: 'owner', errorFor: () => null, canScore: () => true, canScoreGame: () => true }) },
  'react-native-view-shot': {}, 'expo-linear-gradient': { LinearGradient: 'LinearGradient' },
  'expo-sharing': {}, '../components/PlayLog': {}, '../components/FinishLevelModal': {},
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
check('default final shows the official result without a player award or period scoring', () => {
  const game = { id: 'default', homeTeamId: 'h', awayTeamId: 'a', status: 'final',
    defaultWinnerTeamId: 'a', defaultScore: 30 };
  league = { kind: 'league', id: 'l', name: 'Test', season: 'S1', games: [game],
    teams: [{ id: 'h', name: 'Home', playerIds: [] }, { id: 'a', name: 'Away', playerIds: [] }],
    players: [], events: [] };
  const box = Hooks.render(Box, { route: { params: { leagueId: 'l', gameId: 'default' } }, navigation: {} });
  assert.equal(JSON.stringify(stats.gameScore(league, game)), '{"home":0,"away":30}');
  assert.ok(nodes(box.element).some(n => n.props?.label === 'FINAL · DEFAULT'));
  assert.ok(!nodes(box.element).some(n => n.props?.children === 'By period'));
  assert.ok(!nodes(box.element).some(n => n.props?.children === '★ PLAYER OF THE GAME'));
  box.unmount();
  const final = Hooks.render(Final, { route: { params: { leagueId: 'l', gameId: 'default' } }, navigation: {} });
  assert.ok(nodes(final.element).some(n => n.props?.children === 'FINAL · DEFAULT'));
  assert.ok(!nodes(final.element).some(n => n.props?.children === '🏅 PLAYER OF THE GAME'));
  final.unmount();
});
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
const GOOGLE_G = 3;
const { Segmented, GoogleButton, AppleButton, SignInModal, ProfileSheet } = load('src/components/ui.tsx', {
  react: Hooks, 'react-native': { ...rn, Image: 'Image', Animated: {
    View: 'Animated.View', Value: class { interpolate() { return 0; } },
    timing: () => ({ start(done) { done?.(); } }),
  } }, '../theme': theme,
  'react-native-gesture-handler': {}, 'react-native-safe-area-context': {},
  'expo-linear-gradient': imports['expo-linear-gradient'],
  'expo-apple-authentication': {
    AppleAuthenticationButton: 'AppleNative',
    AppleAuthenticationButtonType: { CONTINUE: 'continue' },
    AppleAuthenticationButtonStyle: { WHITE: 'white' },
  },
  '../../assets/sponsor-bpbl-clothing-inverse.png': 1, '../../assets/sponsor-bpbl-clothing.png': 2,
  '../../assets/google-g.png': GOOGLE_G,
});
check('two and five tab bars keep the selected fill inside its cell when labels wrap', () => {
  for (const options of [
    ['SAMARITANS', 'TIGS HANDYMAN AND DOC FRANK'],
    ['Standings', 'Leaders', 'Games', 'Schedule', 'Roster'],
  ]) for (let selected = 0; selected < options.length; selected++) {
    const root = Hooks.render(Segmented, { options, value: selected, onChange() {} });
    const tabs = nodes(root.element).filter(n => n.type === 'Pressable');
    assert.equal(tabs.length, options.length);
    for (const [index, tab] of tabs.entries()) {
      assert.equal(tab.props.style.flex, 1, 'each tab gets an equal share of the available width');
      assert.equal(tab.props.style.minWidth, 0, 'long labels can shrink on compact phones');
      assert.equal(tab.props.style.minHeight, 44);
      assert.equal(tab.props.style.justifyContent, 'center');
      const [fill, label] = tab.props.children;
      if (index === selected) {
        assert.equal(fill.type, 'LinearGradient');
        assert.equal(fill.props.pointerEvents, 'none');
        assert.equal(fill.props.style.position, 'absolute');
        for (const edge of ['top', 'bottom', 'left', 'right']) assert.equal(fill.props.style[edge], 0);
      } else assert.equal(fill, false);
      assert.equal(label.props.numberOfLines, 2);
      assert.equal(label.props.style.textAlign, 'center');
      assert.equal(label.props.style.fontSize, 13, 'wide tablet cells keep a readable label size');
      assert.equal(label.props.adjustsFontSizeToFit, true, 'compact cells can fit their labels');
    }
    root.unmount();
  }
});
check('Apple and Google sign-in controls share a responsive frame', () => {
  const google = Hooks.render(GoogleButton, { onPress() {} });
  const apple = Hooks.render(AppleButton, { onPress() {} });
  const googleFrame = google.element.props.style[0];
  const appleFrame = apple.element.props.style[0];
  assert.equal(googleFrame.width, '100%');
  assert.equal(appleFrame.width, '100%');
  assert.equal(googleFrame.height, appleFrame.height);
  assert.equal(apple.element.props.children.type, 'AppleNative');
  assert.equal(apple.element.props.children.props.style.width, '100%');
  google.unmount(); apple.unmount();
});
// Apple's native control cannot be given a font: its title is 43% of the
// button's height (Apple HIG). At 52 pt that was 22 pt beside Google's 19 pt,
// which is the mismatch reported from the preview build.
check('Google label is the size Apple gives its native title at the shared height', () => {
  const google = Hooks.render(GoogleButton, { onPress() {} });
  const frame = google.element.props.style[0];
  const [logo, label] = google.element.props.children;
  assert.ok(frame.height >= 44, 'iOS minimum touch target');
  assert.equal(label.props.style.fontSize, Math.round(frame.height * 0.43),
    "differs from Apple's title at this height");
  assert.equal(label.props.numberOfLines, 1);
  assert.equal(label.props.adjustsFontSizeToFit, true, 'compact phones shrink rather than clip');
  // Apple's native title ignores the system text size; a scaling label would
  // reopen the mismatch one step either side of the default.
  assert.equal(label.props.allowFontScaling, false);
  assert.equal(logo.type, 'Image');
  assert.equal(logo.props.source, GOOGLE_G, "Google's standard multicolour mark, not a letter in the app font");
  google.unmount();
});
check('secondary actions beside the sign-in buttons share their height and are buttons', () => {
  const google = Hooks.render(GoogleButton, { onPress() {} });
  const height = google.element.props.style[0].height;
  google.unmount();
  const modal = Hooks.render(SignInModal, { visible: true, onGoogle() {}, onApple() {}, onCancel() {} });
  const sheet = Hooks.render(ProfileSheet, { visible: true, onClose() {}, user: null, role: 'guest',
    onGoogle() {}, onApple() {}, onSignOut() {}, onSettings() {}, onAbout() {} });
  for (const [root, label] of [[modal, 'Cancel'], [sheet, 'Continue as Guest']]) {
    const action = nodes(root.element).find(n => n.type === 'TouchableOpacity'
      && nodes(n.props.children).some(c => c.props?.children === label));
    assert.ok(action, label);
    assert.equal(action.props.style.minHeight, height, `${label} is not the sign-in buttons' height`);
    assert.equal(action.props.style.justifyContent, 'center');
    assert.equal(action.props.accessibilityRole, 'button');
    const shown = nodes(root.element);
    const appleAt = shown.findIndex(n => n.type === AppleButton), googleAt = shown.findIndex(n => n.type === GoogleButton);
    assert.ok(appleAt >= 0 && appleAt < googleAt, 'Apple appears above Google on iOS');
  }
  modal.unmount(); sheet.unmount();
});
check('Android has no Apple button, so its sign-in controls take the 48 dp touch target', () => {
  const android = load('src/components/ui.tsx', {
    react: Hooks, 'react-native': { ...rn, Image: 'Image', Platform: { OS: 'android' } }, '../theme': theme,
    'react-native-gesture-handler': {}, 'react-native-safe-area-context': {},
    'expo-linear-gradient': imports['expo-linear-gradient'], 'expo-apple-authentication': {},
    '../../assets/sponsor-bpbl-clothing-inverse.png': 1, '../../assets/sponsor-bpbl-clothing.png': 2,
    '../../assets/google-g.png': GOOGLE_G,
  });
  assert.equal(android.AUTH_BUTTON_HEIGHT, 48);
  assert.equal(Hooks.render(android.AppleButton, { onPress() {} }).element, null);
  const google = Hooks.render(android.GoogleButton, { onPress() {} });
  assert.equal(google.element.props.style[0].height, 48);
  assert.equal(google.element.props.children[1].props.style.fontSize, 19, 'same label on both platforms');
  google.unmount();
});
process.exitCode = failures ? 1 : 0;
