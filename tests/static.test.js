const fs = require('fs');
const path = require('path');
const ROOT = process.env.ITALA_ROOT || require('path').join(__dirname, '..');

let pass = 0, fail = 0, warn = 0;
const problems = [], warnings = [];
const ok = (n, c, d) => c ? pass++ : (fail++, problems.push(`${n}${d ? ' :: ' + d : ''}`));
const soft = (n, c, d) => c ? pass++ : (warn++, warnings.push(`${n}${d ? ' :: ' + d : ''}`));

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}
const srcFiles = walk('src').concat(['App.tsx']);

// ---------------------------------------------------------------------------
// CHECK 1 — route parity. Every route declared in navigation.ts must be
// registered in App.tsx and vice versa. This is exactly the class of bug that
// made "Finish Game" silently dead (screen imported but never registered).
// ---------------------------------------------------------------------------
const nav = read('src/navigation.ts');
const app = read('App.tsx');
const pStart = nav.indexOf('RootStackParams = {');
if (pStart < 0) { console.error('FATAL: could not locate RootStackParams in navigation.ts'); process.exit(2); }
const paramBlock = nav.slice(pStart, nav.indexOf('\n};', pStart));
const declared = new Set();
for (const m of paramBlock.matchAll(/^\s{2}(\w+)\s*:/gm)) declared.add(m[1]);
if (declared.size === 0) { console.error('FATAL: parsed zero routes'); process.exit(2); }
const registered = new Set();
for (const m of app.matchAll(/<Stack\.Screen\s+name="(\w+)"/g)) registered.add(m[1]);

for (const r of declared) {
  ok(`route "${r}" registered in App.tsx`, registered.has(r),
     'declared in navigation.ts but has no <Stack.Screen>');
}
for (const r of registered) {
  ok(`route "${r}" declared in navigation.ts`, declared.has(r),
     'registered in App.tsx but missing from RootStackParams');
}

// ---------------------------------------------------------------------------
// CHECK 2 — every navigate()/replace()/push() target is a real route.
// A typo here is a runtime crash, invisible to the type checker when the
// literal is built dynamically.
// ---------------------------------------------------------------------------
for (const f of srcFiles) {
  const src = read(f);
  for (const m of src.matchAll(/navigation\.(?:navigate|replace|push)\(\s*'([^']+)'/g)) {
    ok(`navigate('${m[1]}') from ${f} targets a real route`, declared.has(m[1]),
       `route "${m[1]}" is not in RootStackParams`);
  }
}

// ---------------------------------------------------------------------------
// CHECK 3 — positional array assumptions in the sync layer. Relying on
// "the row I just added is last in the array" is what silently wrote the
// wrong player/team when several writes overlapped.
// ---------------------------------------------------------------------------
const sync = read('src/sync/sync.ts');
const positional = [...sync.matchAll(/\.(teams|players|games|events)\[\s*\w+\.\1\.length\s*-\s*1\s*\]/g)];
for (const m of positional) {
  const line = sync.slice(0, m.index).split('\n').length;
  soft(`sync.ts:${line} positional "${m[0]}"`, false,
       'relies on the just-added row being last; prefer an explicit id');
}
ok('sync layer positional-assumption scan ran', true);

// ---------------------------------------------------------------------------
// CHECK 4 — non-null assertions on .find(). These crash the app when the row
// is missing, which is how a missing team killed the live-game screen.
// ---------------------------------------------------------------------------
for (const f of srcFiles) {
  const src = read(f);
  for (const m of src.matchAll(/\.find\([^)]*\)!/g)) {
    const line = src.slice(0, m.index).split('\n').length;
    ok(`${f}:${line} no non-null assertion on .find()`, false,
       'a missing row here crashes the screen; guard instead');
  }
}
ok('non-null assertion scan ran', true);

// ---------------------------------------------------------------------------
// CHECK 5 — every reducer action in the Action union is handled by both the
// reducer and (where it mutates server data) the sync layer. An action the
// sync layer forgets silently fails to persist.
// ---------------------------------------------------------------------------
const store = read('src/store/StoreProvider.tsx');
const actionUnion = store.slice(store.indexOf('export type Action ='), store.indexOf('const defaultSettings'));
const actions = [...actionUnion.matchAll(/t:\s*'([A-Z_]+)'/g)].map(m => m[1]);
ok('action union parsed', actions.length > 20, `found ${actions.length}`);
const reducerBody = store.slice(store.indexOf('export function reducer'));
for (const a of actions) {
  if (a === 'HYDRATE') continue;
  ok(`reducer handles ${a}`, reducerBody.includes(`case '${a}'`), 'no case in reducer');
}
// sync coverage: local-only actions legitimately have no server write
const localOnly = new Set(['HYDRATE', 'SET_SETTINGS']);
// NOTE: UNDO_EVENT/REDO_EVENT must persist — a local-only undo reappears on the next pull.
for (const a of actions) {
  if (localOnly.has(a)) continue;
  soft(`sync layer persists ${a}`, sync.includes(`case '${a}'`),
       'no case in sync.ts — changes will not reach the server');
}

// ---------------------------------------------------------------------------
// CHECK 6 — schema/RPC parity. Every sb.rpc('name') the client calls must
// exist as a function in schema.sql, or it fails at runtime only.
// ---------------------------------------------------------------------------
const schema = read('supabase/schema.sql');
const rpcCalls = new Set();
for (const f of srcFiles) {
  for (const m of read(f).matchAll(/\.rpc\(\s*'(\w+)'/g)) rpcCalls.add(m[1]);
}
for (const r of rpcCalls) {
  ok(`RPC "${r}" defined in schema.sql`,
     new RegExp(`create or replace function public\\.${r}\\b`).test(schema),
     'called by the client but not defined in schema.sql');
}

// ---------------------------------------------------------------------------
// CHECK 7 — every table the client writes to exists in schema.sql.
// ---------------------------------------------------------------------------
const tables = new Set();
for (const f of srcFiles) {
  for (const m of read(f).matchAll(/\.from\(\s*'(\w+)'\s*\)/g)) tables.add(m[1]);
}
for (const t of tables) {
  ok(`table "${t}" exists in schema.sql`,
     new RegExp(`create table if not exists public\\.${t}\\b`).test(schema),
     'client reads/writes this table but schema.sql does not create it');
}

// ---------------------------------------------------------------------------
// CHECK 8 — canonical files must retain the user's required values.
// ---------------------------------------------------------------------------
const appJson = JSON.parse(read('app.json'));
ok('app.json keeps EAS projectId',
   appJson.expo?.extra?.eas?.projectId === 'bf4508b7-20f9-4342-a315-9b6f6121aef9');
// RECORD_AUDIO and CAMERA were reaching the Android manifest even though the app
// only ever calls launchImageLibraryAsync with MediaTypeOptions.Images. An
// Android permission with no feature behind it cannot be answered honestly on
// Google Play's Data safety form and invites review questions.
//
// The source is expo-image-picker's config plugin, which adds both for video
// capture unless told otherwise - so deleting them from android.permissions does
// nothing, the plugin puts them back. Passing microphonePermission/
// cameraPermission false both omits them AND emits tools:node="remove", which
// stops any other package reintroducing them. These checks guard the mechanism
// that actually works, not the array that looked like the cause.
// (This check is inverted from its original form, which asserted RECORD_AUDIO
// was present.)
ok('app.json declares no RECORD_AUDIO permission',
   !(appJson.expo?.android?.permissions ?? []).includes('android.permission.RECORD_AUDIO'),
   'nothing in the app records audio - an unused permission is a Play review problem');
{
  const picker = (appJson.expo?.plugins ?? [])
    .find(p => Array.isArray(p) && p[0] === 'expo-image-picker');
  ok('expo-image-picker plugin is configured with options', Array.isArray(picker) && !!picker[1],
     'without options the plugin adds RECORD_AUDIO and CAMERA to the manifest');
  ok('expo-image-picker blocks the microphone permission', picker?.[1]?.microphonePermission === false,
     'must be exactly false - that is what emits tools:node="remove" for RECORD_AUDIO');
  ok('expo-image-picker blocks the camera permission', picker?.[1]?.cameraPermission === false,
     'the app never calls launchCameraAsync');
}
ok('DEPLOYMENT.md keeps the zip-apply commands', read('DEPLOYMENT.md').includes('Expand-Archive'));

// ---------------------------------------------------------------------------
// CHECK 9 — the sync primitives stay wired into dispatch.
// ---------------------------------------------------------------------------
// tests/sync.test.js drives the real primitives, but it builds its own dispatch
// glue. These checks make sure StoreProvider's real dispatch still uses them, so
// the suite cannot pass while the app has quietly stopped calling them.
{
  const store = read('src/store/StoreProvider.tsx');
  const sync = read('src/sync/sync.ts');

  ok('dispatch serializes server writes through enqueuePush',
     /enqueuePush\(\s*\(\)\s*=>\s*pushAction\(/.test(store),
     'pushes fired independently let a DELETE overtake the INSERT it undoes');
  ok('dispatch resolves the undo target before pushing',
     /resolveUndoTarget\(\s*stateRef\.current/.test(store),
     'without the id the sync layer cannot delete the undone row');
  ok('dispatch tombstones the undone event',
     /guardUndoneEvent\(action\.eventId\)/.test(store),
     'an in-flight refetch would resurrect the undone stat');
  ok('redo lifts the tombstone', /releaseUndoGuard\(/.test(store));
  ok('HYDRATE drops tombstoned events',
     /undoneEventIds\(\)/.test(store) && /filter\(e => !undone\.has\(e\.id\)\)/.test(store));
  ok('the undo delete asks for the deleted rows back',
     /delete\(\)\.eq\('id', action\.eventId\)\.select\(/.test(sync),
     'PostgREST reports success for a delete that RLS filtered to nothing');
  ok('a refused undo delete is surfaced, not logged',
     /UNDO_EVENT/.test(sync) && /BULK_IMPORT_ROSTER\|UNDO_EVENT/.test(sync),
     'pushAction must rethrow so the sync badge shows an error');
}

// ---------------------------------------------------------------------------
// CHECK 10 — no plaintext admin password anywhere in the tree.
// ---------------------------------------------------------------------------
// The admin password must live only in the database, as a hash. A literal in the
// client is shipped in the JS bundle; a literal in schema.sql is published in the
// repo. Neither is recoverable once committed, so this check is the guard.
{
  const files = ['supabase/schema.sql', 'src/store/AdminProvider.tsx', 'README.md',
                 'DEPLOYMENT.md', 'AUTH_SETUP.md', 'app.json', '.env.example'];
  // Matches an assignment/seed of a quoted literal to something password-shaped.
  const seeds = /(password|passcode|secret)\w*\s*(=|:|,)\s*'[^']{6,}'/i;
  for (const f of files) {
    const src = read(f);
    ok(`${f} has no hard-coded password literal`, !seeds.test(src),
       (src.match(seeds) || [''])[0]);
  }
  ok('schema.sql stores a hash, not a password',
     /password_hash/.test(read('supabase/schema.sql')));
  ok('schema.sql does not seed a usable admin secret',
     !/insert into public\.admin_secret[\s\S]{0,200}values\s*\(\s*1\s*,\s*'/.test(read('supabase/schema.sql')),
     'a seeded password in a public repo is a published password');
  ok('elevate_to_admin throttles attempts',
     /admin_attempts/.test(read('supabase/schema.sql')),
     'the RPC is granted to anon, so unthrottled it is an online password oracle');
}

// ---------------------------------------------------------------------------
// CHECK 11 — no leftover browser storage APIs (unsupported in this app) and no
// stray debug artefacts.
// ---------------------------------------------------------------------------
for (const f of srcFiles) {
  const src = read(f);
  ok(`${f} free of localStorage`, !/\blocalStorage\b/.test(src));
}

// ---------------------------------------------------------------------------
// CHECK 12 - the runner must not spawn `npx` as a bare executable. On Windows
// `npx` is a .cmd shim: execFileSync('npx') fails ENOENT, and 'npx.cmd' fails
// EINVAL on Node >= 20.12, which refuses to spawn .cmd/.bat without a shell -
// which is what made `npm test` unrunnable natively on Windows. `shell: true`
// does start, but Node then concatenates argv unescaped (DEP0190), mangling the
// absolute --alias paths whenever the checkout directory contains a space. The
// runner resolves npm's own npx-cli.js and runs it under process.execPath.
// Comments are stripped first: the explanation in run.js quotes the very
// pattern being banned here.
// ---------------------------------------------------------------------------
{
  const runner = read('tests/run.js').replace(/^[ \t]*\/\/.*$/gm, '');
  ok('tests/run.js does not spawn npx as a bare executable',
     !/(?:run|execFileSync|execSync|spawnSync)\(\s*'npx(?:\.cmd)?'/.test(runner),
     'npx is a .cmd shim on Windows - resolve npm/bin/npx-cli.js and run it under process.execPath');
  ok('tests/run.js resolves npx through npx-cli.js under the current node binary',
     /npx-cli\.js/.test(runner) && /process\.execPath/.test(runner));
}

// ---------------------------------------------------------------------------
// CHECK 13 - CI must actually verify pull requests. This repo shipped with a
// single workflow that pinged Supabase to stop a free project pausing, and
// nothing that ran a test, so any PR could merge with a red suite. These checks
// fail if that workflow is deleted, stops running before merge, or loses the
// flag that makes the database suites mandatory rather than silently skipped.
// ---------------------------------------------------------------------------
{
  const wfDir = path.join(ROOT, '.github', 'workflows');
  const files = fs.existsSync(wfDir)
    ? fs.readdirSync(wfDir).filter(f => /\.ya?ml$/.test(f))
    : [];
  const verifier = files
    .map(f => fs.readFileSync(path.join(wfDir, f), 'utf8'))
    .find(b => /tests\/run\.js/.test(b));
  ok('a GitHub Actions workflow runs tests/run.js', !!verifier,
     'no workflow executes the regression suite - pull requests would merge unverified');
  ok('that workflow runs before merge, on pull_request',
     !!verifier && /^\s*pull_request:/m.test(verifier),
     'running only after merge to main defeats the point');
  ok('that workflow makes the database checks mandatory',
     !!verifier && /ITALA_REQUIRE_DB/.test(verifier),
     'without it tests/sql/run.js skips silently and CI goes green with no database coverage');
}


// ---------------------------------------------------------------------------
// CHECK 15 - the privacy policy must keep covering what the store declarations
// depend on. Three things describe the same behaviour and must not disagree:
// what the code does, the policy in site/privacy/, and the Apple/Google tables
// in DEPLOYMENT.md. The policy is the one nobody re-reads, so deleting a
// section from it fails the build instead of going unnoticed until a store
// review or a removal request.
//
// These are presence checks on prose, not proof the prose is accurate. They stop
// a section vanishing; they cannot stop it becoming wrong.
// ---------------------------------------------------------------------------
{
  const policyPath = 'site/privacy/index.html';
  const exists = fs.existsSync(path.join(ROOT, policyPath));
  ok('a privacy policy exists in the repo', exists,
     'both stores require a reachable policy URL, and it has to live somewhere version-controlled');
  if (exists) {
    const policy = read(policyPath);
    for (const [label, needle] of [
      // The single most consequential disclosure: the read_all_* RLS policies are
      // `using (auth.uid() is not null)`, so this is not a nicety.
      ['discloses that any signed-in session can read every roster', 'anonymous spectator session, can read'],
      ['covers roster data about people who are not app users', 'people who are not users'],
      ['gives a route to have a name removed', 'want a name and its statistics removed'],
      ['has a children section', '5. Children'],
      ['discloses the sponsor promo tap counter', 'increments a counter on that sponsor'],
      ['names Supabase as a processor', 'Supabase'],
      ['covers account deletion', 'Delete account'],
      ['cites the NZ Privacy Act 2020', 'Privacy Act 2020'],
      // Guards against someone "fixing" the policy by declaring device location.
      ['states the venue is not device location', 'not device location'],
    ]) {
      ok(`privacy policy ${label}`, policy.includes(needle), `missing: "${needle}"`);
    }
  }

  // The declarations in DEPLOYMENT.md are the other half of the same pair.
  const deploy = read('DEPLOYMENT.md');
  ok('DEPLOYMENT.md declares the promo tap counter as Usage Data',
     /Usage Data → Advertising Data/.test(deploy) && /bump_promo_tap/.test(deploy),
     'server-side promo taps are collected and have to appear on both store forms');
  ok('DEPLOYMENT.md tells you not to declare Location',
     /Do not declare Location/.test(deploy),
     'the venue field is user-typed text, and declaring device location would be false');
  ok('DEPLOYMENT.md still refuses "Data Not Collected"',
     /does collect data/.test(deploy));
}

console.log('='.repeat(64));
console.log(`STATIC CHECKS:  ${pass} passed,  ${fail} failed,  ${warn} warnings`);
if (problems.length) {
  console.log('-'.repeat(64));
  console.log('FAILURES:');
  problems.forEach(p => console.log('  ✗ ' + p));
}
if (warnings.length) {
  console.log('-'.repeat(64));
  console.log('WARNINGS (review, not necessarily bugs):');
  warnings.forEach(w => console.log('  ! ' + w));
}
console.log('='.repeat(64));

// Exit non-zero on failure. Without this the runner treated every static check as
// advisory: the whole suite could report failures and `npm test` would still say
// "all suites passed", so none of these checks could ever fail a build.
// Warnings stay advisory, by design.
process.exit(fail ? 1 : 0);
