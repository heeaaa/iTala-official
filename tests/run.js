#!/usr/bin/env node
// iTala regression runner.
//
//   node tests/run.js
//
// Bundles the pure logic (reducer, stats engine, roster parser) with the native
// modules stubbed out, then runs the reducer/stats suite, the two-device sync suite and the static
// structural checks. No devDependencies are added to the project: esbuild is
// fetched on demand via npx.
//
// What this covers: state transitions, the stats engine, the roster parser, and
// structural invariants (route registration parity, RPC/table parity against
// schema.sql, non-null assertions, canonical-file values).
//
// What this does NOT cover: rendering, navigation, gestures, native modules
// (share-card capture, haptics, image picker) and live Supabase/RLS behaviour.
// Those still need a device. See tests/sql/ for the database-side checks.

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const H = path.join(__dirname, 'harness');
const BUNDLE = path.join(__dirname, '.test-bundle.js');
// A SECOND bundle, for the provider suite. It cannot share the first one: that
// one aliases react to a stub whose hooks are constants, which is the right
// trade for importing pure functions out of the app and makes running a
// component impossible. This one carries a real (tiny) hook runtime, a
// react-native shim whose AppState actually emits, and a Supabase handle that
// forwards to the emulator - so StoreProvider itself runs.
const PROVIDER_BUNDLE = path.join(__dirname, '.provider-bundle.js');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
}

// npx cannot be spawned directly on Windows: `npx` is a .cmd shim, so
// execFileSync('npx') fails ENOENT, and 'npx.cmd' fails EINVAL on Node >= 20.12,
// which refuses to spawn .cmd/.bat without a shell. `shell: true` does start, but
// Node then concatenates argv without escaping it (DEP0190) - and the esbuild
// --alias arguments below carry absolute paths, so a checkout under a directory
// with a space in its name would be silently mangled. Running npm's own
// npx-cli.js under the current node binary sidesteps both, on every OS.
function resolveNpx() {
  const dir = path.dirname(process.execPath);
  const candidates = [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),              // Windows layout
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'), // Unix layout
  ];
  for (const cli of candidates) {
    if (fs.existsSync(cli)) return { cmd: process.execPath, prefix: [cli], opts: {} };
  }
  // Last resort: let the shell resolve it. Only reached when npm lives somewhere
  // unusual; called out here so a failure points at this branch rather than
  // looking like a missing npx.
  return { cmd: 'npx', prefix: [], opts: { shell: true } };
}
const NPX = resolveNpx();
function npx(args, opts = {}) {
  return run(NPX.cmd, [...NPX.prefix, ...args], { ...NPX.opts, ...opts });
}

console.log('• bundling pure logic with native modules stubbed…');
const esbuildArgs = [
  '--yes', 'esbuild@0.24.0',
  path.join('tests', 'entry.ts'),
  '--bundle', '--platform=node', '--format=cjs',
  `--outfile=${path.relative(ROOT, BUNDLE)}`,
  `--alias:react=${path.join(H, 'pkg', 'react')}`,
  `--alias:react-native=${path.join(H, 'pkg', 'rn')}`,
  `--alias:@react-native-async-storage/async-storage=${path.join(H, 'stubs', 'asyncstorage.js')}`,
  `--alias:@supabase/supabase-js=${path.join(H, 'stubs', 'supabase.js')}`,
  `--alias:expo-haptics=${path.join(H, 'stubs', 'haptics.js')}`,
  `--alias:expo-notifications=${path.join(H, 'stubs', 'notifications.js')}`,
  `--alias:expo-device=${path.join(H, 'stubs', 'empty.js')}`,
  `--alias:expo-constants=${path.join(H, 'stubs', 'empty.js')}`,
  '--log-level=error',
];
try {
  npx(esbuildArgs);
} catch (e) {
  // The reason was previously discarded, so every bundling failure printed the
  // same guess about the network - unhelpful when the real cause was a syntax
  // error or a missing alias target.
  console.error('\n✗ bundling failed:', e.message);
  console.error('  (if that looks like a fetch problem, check network access for npx esbuild)');
  process.exit(2);
}
if (!fs.existsSync(BUNDLE)) { console.error('✗ bundle not produced'); process.exit(2); }

console.log('• bundling StoreProvider with a live hook runtime…');
try {
  npx([
    '--yes', 'esbuild@0.24.0',
    path.join('tests', 'provider-entry.ts'),
    '--bundle', '--platform=node', '--format=cjs',
    `--outfile=${path.relative(ROOT, PROVIDER_BUNDLE)}`,
    `--alias:react=${path.join(H, 'pkg', 'react-live')}`,
    `--alias:react-native=${path.join(H, 'pkg', 'rn-live')}`,
    `--alias:@react-native-async-storage/async-storage=${path.join(H, 'stubs', 'asyncstorage-live.js')}`,
    `--alias:@supabase/supabase-js=${path.join(H, 'stubs', 'supabase-live.js')}`,
    `--alias:expo-haptics=${path.join(H, 'stubs', 'haptics.js')}`,
    `--alias:expo-notifications=${path.join(H, 'stubs', 'notifications.js')}`,
    `--alias:expo-device=${path.join(H, 'stubs', 'empty.js')}`,
    `--alias:expo-constants=${path.join(H, 'stubs', 'empty.js')}`,
    '--log-level=error',
  ]);
} catch (e) {
  console.error('\n✗ provider bundling failed:', e.message);
  process.exit(2);
}
if (!fs.existsSync(PROVIDER_BUNDLE)) { console.error('✗ provider bundle not produced'); process.exit(2); }

const env = { ...process.env, ITALA_BUNDLE: BUNDLE, ITALA_ROOT: ROOT };
let failed = 0;

console.log('\n• type check');
try { npx(['tsc', '--noEmit']); console.log('  tsc clean'); }
catch { console.error('  tsc reported errors'); failed++; }

console.log('\n• reducer / stats / parser suite');
try { run('node', [path.join('tests', 'reducer.test.js')], { env }); }
catch { failed++; }

console.log('\n• two-device sync suite');
try { run('node', [path.join('tests', 'sync.test.js')], { env }); }
catch { failed++; }

console.log('\n• provider suite (StoreProvider boot ordering and autosave)');
try {
  run('node', [path.join('tests', 'provider.test.js')], {
    env: {
      ...env,
      ITALA_PROVIDER_BUNDLE: PROVIDER_BUNDLE,
      // SYNC_ENABLED is `!!(URL && KEY)`, read once when the module loads, so a
      // suite whose whole subject is the boot pull has to be given
      // credential-SHAPED values. Nothing here reaches a network: getSupabase's
      // client is the emulator (see stubs/supabase-live.js) and the host is
      // .invalid, which is reserved and unresolvable by definition.
      EXPO_PUBLIC_SUPABASE_URL: 'https://provider-suite.invalid',
      EXPO_PUBLIC_SUPABASE_ANON_KEY: 'provider-suite-not-a-real-key',
    },
  });
} catch { failed++; }

console.log('\n• static structural checks');
try { run('node', [path.join('tests', 'guestSession.test.js')], { env }); }
catch { failed++; }
try { run('node', [path.join('tests', 'contentReports.test.js')], { env }); }
catch { failed++; }
try { run('node', [path.join('tests', 'contentReports.integration.test.js')], { env }); }
catch { failed++; }
if (process.env.ITALA_PGLITE_MODULE) {
  try { run('node', [path.join('tests', 'contentReports.database.test.js')], { env }); }
  catch { failed++; }
}
try { run('node', [path.join('tests', 'static.test.js')], { env }); }
catch { failed++; }

// Database-side checks. These need a Postgres to talk to (PG* env vars); the
// runner skips them cleanly when there isn't one, so `npm test` still works on a
// laptop with no server.
console.log('\n• database checks (schema.sql against a real Postgres)');
try { run('node', [path.join('tests', 'sql', 'run.js')], { env }); }
catch { failed++; }

try { fs.unlinkSync(BUNDLE); } catch {}
try { fs.unlinkSync(PROVIDER_BUNDLE); } catch {}

console.log(failed ? `\n✗ ${failed} suite(s) reported problems` : '\n✓ all suites passed');
process.exit(failed ? 1 : 0);
