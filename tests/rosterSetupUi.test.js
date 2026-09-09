const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const Hooks = require('./harness/pkg/react-live');

function load(file, imports) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText, { exports, setTimeout: () => {}, require: name => {
    if (!(name in imports)) throw Error(`Missing import ${name}`);
    return imports[name];
  } });
  return exports;
}
function nodes(n) {
  if (!n || typeof n !== 'object') return [];
  if (Array.isArray(n)) return n.flatMap(nodes);
  return [n, ...nodes(n.props?.children)];
}
let owner = false, synced = true;
const actions = [], routes = [];
const league = { id: 'new', name: 'Sunday', season: 'S1', kind: 'league', teams: [], players: [] };
const imports = {
  react: Hooks,
  'react-native': { View: 'View', TextInput: 'TextInput', Pressable: 'Pressable', ScrollView: 'ScrollView' },
  '@react-navigation/native': { useFocusEffect: callback => Hooks.useEffect(callback, [callback]) },
  '../components/ui': Object.fromEntries(['Screen', 'Txt', 'Field', 'Button', 'Toggle', 'Card', 'Pill', 'TeamBadge'].map(x => [x, x])),
  '../store/StoreProvider': { useStore: () => ({ dispatch: a => actions.push(a), synced }), useLeague: () => league },
  '../store/AdminProvider': { useAdmin: () => ({ canScore: () => owner, isOwner: () => owner, reloadMemberships: async () => {}, user: { id: 'u1' } }) },
  '../theme': { space: n => n, colors: {}, radius: {}, font: {} },
  '../lib/format': { uid: () => 'new' },
  '../store/rosterDraft': { loadRosterDraft: async () => null },
};
const Manage = load('src/screens/ManageRosterScreen.tsx', imports).default;
const nav = { replace: (...args) => routes.push(args), navigate() {} };
const render = params => Hooks.render(Manage, { route: { params }, navigation: nav });
const buttons = root => nodes(root.element).filter(n => n.type === 'Button').map(n => n.props.title);

// Characterize the old display: missing membership hides inputs but leaves Done.
const ordinary = render({ leagueId: 'new' });
assert.ok(buttons(ordinary).some(t => t.startsWith('Done')));
assert.ok(!buttons(ordinary).some(t => t.startsWith('Bulk import')));
ordinary.unmount();

const setup = render({ leagueId: 'new', awaitOwner: true });
assert.ok(JSON.stringify(setup.element).includes('Preparing roster'));
assert.ok(!buttons(setup).some(t => t.startsWith('Done')));
owner = true; setup.dirty = true; setup.flush();
assert.ok(buttons(setup).some(t => t.startsWith('Bulk import')));
assert.ok(buttons(setup).includes('Add'));
assert.ok(buttons(setup).some(t => t.startsWith('Done')));
owner = false; setup.dirty = true; setup.flush();
assert.ok(!JSON.stringify(setup.element).includes('Preparing roster'), 'later loss of access must not restart setup');
assert.ok(!buttons(setup).includes('Add'));
setup.unmount();

synced = false;
const local = render({ leagueId: 'new', awaitOwner: true });
assert.ok(!JSON.stringify(local.element).includes('Preparing roster'));
local.unmount();
const Create = load('src/screens/CreateLeagueScreen.tsx', imports).default;
const create = Hooks.render(Create, { route: { params: {} }, navigation: nav });
nodes(create.element).find(n => n.type === 'Field').props.onChangeText('Sunday'); create.flush();
nodes(create.element).find(n => n.type === 'Button').props.onPress();
assert.equal(actions[0].t, 'ADD_LEAGUE');
assert.equal(routes[0][0], 'ManageRoster');
assert.equal(routes[0][1].awaitOwner, true);
create.unmount();
console.log('PASS: creation waits for owner controls as a whole; ordinary, local and later permission changes retain their behavior.');

const ui = load('src/components/ui.tsx', {
  react: Hooks,
  'react-native': { ...imports['react-native'], KeyboardAvoidingView: 'KeyboardAvoidingView', Platform: { OS: 'ios' }, StyleSheet: { create: x => x } },
  'react-native-gesture-handler': {},
  'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
  'expo-linear-gradient': {},
  '../theme': imports['../theme'],
  '../../assets/sponsor-bpbl-clothing-inverse.png': 1,
  '../../assets/sponsor-bpbl-clothing.png': 2,
});
for (const offset of [undefined, 96]) {
  const screen = Hooks.render(ui.Screen, { children: 'content', keyboardVerticalOffset: offset });
  const avoiding = nodes(screen.element).find(n => n.type === 'KeyboardAvoidingView');
  assert.equal(avoiding.props.keyboardVerticalOffset, offset ?? 0);
  assert.equal(avoiding.props.behavior, 'padding');
  screen.unmount();
}
console.log('PASS: paste-screen keyboard offset is forwarded; other screens retain the default offset and behavior.');
