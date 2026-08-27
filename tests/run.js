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

const { execFileSync, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const H = path.join(__dirname, 'harness');
const BUNDLE = path.join(__dirname, '.test-bundle.js');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
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
  run('npx', esbuildArgs);
} catch (e) {
  console.error('\n✗ bundling failed. Is network access available for npx esbuild?');
  process.exit(2);
}
if (!fs.existsSync(BUNDLE)) { console.error('✗ bundle not produced'); process.exit(2); }

const env = { ...process.env, ITALA_BUNDLE: BUNDLE, ITALA_ROOT: ROOT };
let failed = 0;

console.log('\n• type check');
try { run('npx', ['tsc', '--noEmit']); console.log('  tsc clean'); }
catch { console.error('  tsc reported errors'); failed++; }

console.log('\n• reducer / stats / parser suite');
try { run('node', [path.join('tests', 'reducer.test.js')], { env }); }
catch { failed++; }

console.log('\n• two-device sync suite');
try { run('node', [path.join('tests', 'sync.test.js')], { env }); }
catch { failed++; }

console.log('\n• static structural checks');
try { run('node', [path.join('tests', 'static.test.js')], { env }); }
catch { failed++; }

// Database-side checks. These need a Postgres to talk to (PG* env vars); the
// runner skips them cleanly when there isn't one, so `npm test` still works on a
// laptop with no server.
console.log('\n• database checks (schema.sql against a real Postgres)');
try { run('node', [path.join('tests', 'sql', 'run.js')], { env }); }
catch { failed++; }

try { fs.unlinkSync(BUNDLE); } catch {}

console.log(failed ? `\n✗ ${failed} suite(s) reported problems` : '\n✓ all suites passed');
process.exit(failed ? 1 : 0);
