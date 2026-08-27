#!/usr/bin/env node
// Runs the tests/sql/*.test.sql suites against a real Postgres.
//
//   node tests/sql/run.js                 # all suites
//   node tests/sql/run.js admin_secret    # one suite (matches on filename)
//
// Connection comes from the standard PG* environment variables (PGHOST,
// PGUSER, PGPASSWORD, PGPORT). If psql is not on PATH, or no server answers,
// the suite SKIPS rather than fails - these checks need a database, and the
// pure-logic suites must still be runnable without one.
//
// Each run creates a throwaway database, loads harness.sql (auth stubs + table
// shapes), then loads only the section of supabase/schema.sql the suite needs,
// so the assertions run against the real shipped SQL rather than a copy.

'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8');

// Slice a named region out of schema.sql so a suite exercises the shipped SQL.
// Anchors are literal substrings; the slice runs from the start of `from` to the
// end of `to`.
function slice(from, to) {
  const a = SCHEMA.indexOf(from);
  const b = SCHEMA.indexOf(to);
  if (a < 0 || b < 0) throw new Error(`schema.sql: could not find anchors\n  from: ${from}\n  to:   ${to}`);
  return SCHEMA.slice(a, b + to.length);
}

const SECTIONS = {
  // Admin password storage + the elevate/lock RPCs.
  admin: () => slice(
    '-- pgcrypto supplies crypt()',
    'grant execute on function public.lock_admin() to anon, authenticated;',
  ),

  // The PRE-hardening admin_secret layout, verbatim, so the upgrade path can be
  // tested: plaintext `password text not null`, no password_hash, seeded with the
  // value that shipped in git history. Load this before `admin` to simulate an
  // existing project. Kept as a literal on purpose — it must not track whatever
  // schema.sql happens to say today.
  legacy_admin: () => `
    create table if not exists public.admin_secret (
      id       int primary key default 1,
      password text not null,
      check (id = 1)
    );
    alter table public.admin_secret enable row level security;
    insert into public.admin_secret (id, password) values (1, 'bpblcourtside')
    on conflict (id) do nothing;
  `,
};

function havePsql() {
  const r = spawnSync('psql', ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

function psql(db, args, input) {
  return execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-X', '-d', db, ...args], {
    input,
    encoding: 'utf8',
    stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  });
}

function serverUp() {
  try { psql('postgres', ['-c', 'select 1']); return true; } catch { return false; }
}

// Skipping when there is no database keeps `npm test` usable on a laptop with
// nothing running - but that default is wrong for CI, where a silent skip means
// a green tick with zero database coverage. ITALA_REQUIRE_DB=1 turns both skips
// into failures, so a CI job that loses its Postgres service fails loudly
// instead of quietly testing nothing.
const REQUIRE_DB = process.env.ITALA_REQUIRE_DB === '1';
function unavailable(reason) {
  if (REQUIRE_DB) {
    console.error(`  ✗ ${reason}`);
    console.error('    ITALA_REQUIRE_DB=1 is set, so the database checks are mandatory here.');
    process.exit(1);
  }
  console.log(`  SKIP: ${reason}`);
  process.exit(0);
}

if (!havePsql()) unavailable('psql not on PATH - database checks need a Postgres server.');
if (!serverUp()) unavailable('no Postgres answering on the PG* connection settings.');

const only = process.argv[2];
const suites = fs.readdirSync(HERE)
  .filter(f => f.endsWith('.test.sql'))
  .filter(f => !only || f.includes(only))
  .sort();

if (!suites.length) { console.log('  no SQL suites matched'); process.exit(0); }

const harness = fs.readFileSync(path.join(HERE, 'harness.sql'), 'utf8');
let failed = 0;

const manual = [];

for (const file of suites) {
  const body = fs.readFileSync(path.join(HERE, file), 'utf8');
  // A suite declares which schema.sql sections it needs:  -- @requires: admin
  const marker = body.match(/--\s*@requires:\s*(.+)/);
  // No marker = the suite expects an operator to load the RPCs it exercises by
  // hand (see tests/README.md). Running it here would load only harness.sql, so
  // every check would query empty tables and "pass" without asserting anything.
  // Skipping loudly beats a vacuous green tick.
  if (!marker) { manual.push(file); continue; }
  const req = marker[1].split(',').map(s => s.trim()).filter(Boolean);

  const db = `itala_t_${file.replace(/\W+/g, '_')}`;
  try { psql('postgres', ['-c', `drop database if exists ${db}`]); } catch {}
  psql('postgres', ['-c', `create database ${db}`]);

  let out = '';
  try {
    // Match Supabase: pgcrypto lives in the `extensions` schema, which is what
    // schema.sql qualifies crypt()/gen_salt() against.
    psql(db, ['-c', 'create schema if not exists extensions']);
    psql(db, ['-c', 'create extension if not exists pgcrypto with schema extensions']);
    // Supabase ships these roles; the schema grants execute to them.
    psql(db, [], `do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end $$;`);
    psql(db, [], harness);
    for (const r of req) {
      if (!SECTIONS[r]) throw new Error(`unknown @requires section '${r}'`);
      psql(db, [], SECTIONS[r]());
    }
    out = psql(db, [], body);
    process.stdout.write(out);
    if (/\bFAIL\b/.test(out)) failed++;
  } catch (e) {
    failed++;
    console.log(`  ✗ ${file} errored`);
    const msg = (e.stdout || '') + (e.stderr || '') + (e.stdout === undefined ? String(e.message) : '');
    console.log(msg.split('\n').filter(Boolean).slice(-12).map(l => '    ' + l).join('\n'));
  } finally {
    try { psql('postgres', ['-c', `drop database if exists ${db}`]); } catch {}
  }
}

if (manual.length) {
  console.log(`  SKIP (manual, no @requires marker): ${manual.join(', ')}`);
  console.log('        these need their RPC sections loaded by hand - see tests/README.md');
}
console.log(failed ? `\n✗ ${failed} SQL suite(s) reported problems` : '\n✓ SQL suites passed');
process.exit(failed ? 1 : 0);
