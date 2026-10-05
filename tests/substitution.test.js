const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const Hooks = require('./harness/pkg/react-live');

function load(file, imports = {}, suffix = '') {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8') + suffix, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText, { exports, require: name => {
    if (!(name in imports)) throw Error(`Missing import ${name}`);
    return imports[name];
  } });
  return exports;
}
const theme = load('src/theme.ts');
const imports = {
  react: Hooks,
  'react-native': Object.fromEntries(['View', 'Pressable', 'ScrollView', 'Modal'].map(x => [x, x])),
  '../components/ui': Object.fromEntries(['Txt', 'Button', 'Segmented'].map(x => [x, x])),
  '../theme': theme,
  '../lib/liveInput': load('src/lib/liveInput.ts'),
  ...Object.fromEntries(['expo-keep-awake', '../store/StoreProvider', '../store/AdminProvider', '../lib/stats', '../components/PlayLog', '../components/FinishLevelModal', '../lib/haptics', '../lib/usePromos'].map(x => [x, {}])),
};
const { SubModal, compareSubPlayers } = load('src/screens/LiveGameScreen.tsx', imports, '\nexport { SubModal, compareSubPlayers };');
function nodes(n) {
  if (!n || typeof n !== 'object') return [];
  return Array.isArray(n) ? n.flatMap(nodes) : [n, ...nodes(n.props?.children)];
}
const players = [
  ['ten', 'Zoe', '10'], ['blank', 'Charlie', ''], ['two', 'Ben', '2'],
  ['none', 'alice'], ['space', 'Bob', '  '], ['zero', 'Zero', '0'],
  ['double', 'Double Zero', '00'], ['dup', 'Amy', '2'],
  ['long', 'Alexandria-Margaret Verylongsurname Anotherlongsurname', '99'],
  ...Array.from({ length: 8 }, (_, i) => [`extra${i}`, `Player ${i}`, String(20 + i)]),
].map(([id, name, number]) => ({ id, name, number }));
const snapshot = JSON.stringify(players);
const sorted = [...players].sort(compareSubPlayers).map(p => p.id);
assert.deepEqual(sorted, ['double', 'zero', 'dup', 'two', 'ten', ...Array.from({ length: 8 }, (_, i) => `extra${i}`), 'long', 'none', 'space', 'blank']);
let subs = [], lineups = [];
const props = {
  team: { id: 't', name: 'A very long team name', color: '#3A78FF', playerIds: [...players.map(p => p.id), 'missing'] },
  players, onCourtIds: ['ten', 'two', 'zero', 'none', 'dup'], foulLimit: 5,
  fouledOut: new Set(['long']), foulsOf: id => id === 'long' ? 5 : 1,
  onClose() {}, onSub: (...ids) => subs.push(ids), onSetLineup: ids => lineups.push([...ids]),
};
const root = Hooks.render(SubModal, props);
const rows = () => nodes(root.element).filter(n => n.type === 'Pressable' && n.props.accessibilityState);
const idOf = row => row.props.key;
const press = row => { assert.ok(!row.props.disabled); row.props.onPress(); root.flush(); };
assert.deepEqual(rows().slice(0, 5).map(idOf), ['zero', 'dup', 'two', 'ten', 'none']);
assert.deepEqual(rows().slice(5).map(idOf), sorted.filter(id => !props.onCourtIds.includes(id)));
assert.ok(rows().slice(5).every(r => r.props.disabled), 'full court requires an OUT selection');
press(rows().find(r => idOf(r) === 'two'));
assert.equal(rows().find(r => idOf(r) === 'two').props.accessibilityState.selected, true);
assert.equal(rows().find(r => idOf(r) === 'long').props.disabled, true);
press(rows().find(r => idOf(r) === 'extra0'));
assert.deepEqual(subs, [['two', 'extra0']], 'sorting must preserve player identity');
assert.ok(rows().slice(5).every(r => r.props.disabled), 'selection clears after sub');
nodes(root.element).find(n => n.type === 'Segmented').props.onChange(1); root.flush();
assert.deepEqual(rows().map(idOf), sorted);
press(rows().find(r => idOf(r) === 'extra1'));
assert.equal(rows().filter(r => r.props.accessibilityState.checked).length, 5, 'cannot pick a sixth player');
press(rows().find(r => idOf(r) === 'two'));
press(rows().find(r => idOf(r) === 'extra1'));
nodes(root.element).find(n => n.type === 'Button').props.onPress();
assert.deepEqual(lineups, [['ten', 'zero', 'none', 'dup', 'extra1']]);
for (const row of rows()) {
  const name = nodes(row).find(n => n.type === 'Txt');
  assert.equal(name.props.style.fontSize, 18);
  assert.equal(name.props.style.flex, 1, 'name shares available width with foul status');
  assert.equal(name.props.style.minWidth, 0);
  assert.equal(name.props.numberOfLines, undefined, 'long names wrap without truncation');
  assert.equal(row.props.style.height, undefined, 'rows grow for wrapped/scaled text');
  assert.ok(row.props.style.minHeight >= 48, 'comfortable touch targets');
}
assert.ok(nodes(root.element).some(n => n.type === 'ScrollView' && n.props.style.flexShrink === 1));
root.unmount();
const empty = Hooks.render(SubModal, { ...props, onCourtIds: [], fouledOut: new Set() });
assert.equal(nodes(empty.element).find(n => n.type === 'Button').props.disabled, true);
empty.unmount();
const open = Hooks.render(SubModal, { ...props, onCourtIds: ['two'] });
nodes(open.element).find(n => n.type === 'Pressable' && n.props.key === 'ten').props.onPress();
assert.deepEqual(subs[1], ['__none__', 'ten']);
open.unmount();
assert.equal(JSON.stringify(players), snapshot, 'display sorting never mutates stored players');
assert.deepEqual(props.onCourtIds, ['ten', 'two', 'zero', 'none', 'dup']);
console.log('PASS: 17-player substitution roster, numeric/alphabetical order, missing/zero/duplicate jerseys, both modes, identity, foul-out and lineup limits, wrapping constraints.');
