#!/usr/bin/env node
/**
 * Everything that can be checked without a phone in your hand, in one command.
 *
 * This exists because of a pattern, not a single bug. Every failure that
 * reached the user in this project so far had the same shape: something was
 * verified at the layer it was written in, and broke at the layer the user
 * actually consumes.
 *
 *   typechecked, never bundled        -> ".js" imports Metro cannot resolve
 *   bundled, never doctored           -> Expo versions wrong for the SDK
 *   ran on Linux, never on Windows    -> a script losing its executable bit
 *   committed, never applied          -> a deleted file surviving a zip
 *
 * So the rule is: check at the OUTERMOST layer you can reach. This script is
 * that layer. Run it before saying anything works.
 *
 *   node tools/preflight.mjs
 *   node tools/preflight.mjs --quick   (skips the two slow steps)
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';

const quick = process.argv.includes('--quick');

/** @type {{name: string, cmd: string, args: string[], slow?: boolean, needs?: () => string | null, why: string}[]} */
const STEPS = [
  {
    name: 'format',
    cmd: 'pnpm',
    args: ['format:check'],
    why: 'Formatting drift fails CI and hides real diffs.',
  },
  {
    name: 'lint',
    cmd: 'pnpm',
    args: ['lint'],
    why: 'Catches dead code, unsafe assertions and unused imports.',
  },
  {
    name: 'typecheck',
    cmd: 'pnpm',
    args: ['typecheck'],
    why: 'Necessary, and nowhere near sufficient. See the bundle step.',
  },
  {
    name: 'tests',
    cmd: 'pnpm',
    args: ['test'],
    why: 'The section 7 maths and the sync engine. If this fails, stop.',
  },
  {
    name: 'expo-doctor',
    cmd: 'pnpm',
    args: ['--filter', '@itala/mobile', 'run', 'expo:doctor'],
    why: 'SDK version mismatches, invalid app config, duplicate native modules. The things that otherwise fail 20 minutes into an EAS build.',
  },
  {
    name: 'bundle',
    cmd: 'pnpm',
    args: ['--filter', '@itala/mobile', 'run', 'bundle:check'],
    slow: true,
    why: 'Proves the app can actually be built. A bad import or a broken Metro config passes tsc and fails here.',
  },
  {
    name: 'database',
    cmd: 'bash',
    args: ['supabase/tests/run.sh'],
    slow: true,
    needs: () => {
      if (process.platform === 'win32') return 'needs bash and a local Postgres; CI covers it';
      if (!which('psql')) return 'psql not installed; CI covers it';
      if (
        run('pg_isready', [
          '-q',
          '-h',
          process.env.PGHOST ?? '/tmp',
          '-p',
          process.env.PGPORT ?? '55432',
        ]).status !== 0
      ) {
        return 'no local Postgres running; CI covers it';
      }
      return null;
    },
    why: 'Row-level security, the admin lockout, and the foreign keys.',
  },
];

function which(bin) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [bin], { stdio: 'ignore', shell: true }).status === 0;
}

function run(cmd, args) {
  return spawnSync(cmd, args, { stdio: 'ignore', shell: true });
}

if (!existsSync('pnpm-workspace.yaml')) {
  console.error('Run this from the repository root.');
  process.exit(1);
}

const results = [];
let failed = false;

for (const step of STEPS) {
  if (quick && step.slow) {
    results.push([step.name, 'SKIP', '--quick']);
    continue;
  }
  const blocked = step.needs?.();
  if (blocked) {
    results.push([step.name, 'SKIP', blocked]);
    continue;
  }

  process.stdout.write(`==> ${step.name}\n`);
  const r = spawnSync(step.cmd, step.args, { stdio: 'inherit', shell: true });
  if (r.status === 0) {
    results.push([step.name, 'PASS', '']);
  } else {
    results.push([step.name, 'FAIL', step.why]);
    failed = true;
  }
}

console.log('\n' + '-'.repeat(72));
for (const [name, status, note] of results) {
  console.log(`  ${status.padEnd(5)} ${name.padEnd(14)} ${note}`);
}
console.log('-'.repeat(72));

const skipped = results.filter((r) => r[1] === 'SKIP');
if (failed) {
  console.log('\nPreflight FAILED. Do not ship this, and do not tell anyone it works.\n');
  process.exit(1);
}
if (skipped.length > 0) {
  console.log(
    `\nPreflight passed, with ${skipped.length} step(s) skipped. Say so rather than claiming a clean run.\n`,
  );
} else {
  console.log('\nPreflight passed in full.\n');
}
