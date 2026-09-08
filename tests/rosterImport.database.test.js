// Real PostgreSQL (WASM), isolated from the user's Supabase project.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.ITALA_PGLITE_MODULE || '@electric-sql/pglite');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const schema = read('supabase/schema.sql').replace(/\r\n/g, '\n');
const section = (start, end) => {
  const a = schema.indexOf(start), b = schema.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return schema.slice(a, b + end.length);
};
(async () => {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated;');
    await db.exec(read('tests/sql/harness.sql'));
    await db.exec(section('-- Helper: returns true if the current auth.uid() is an admin.', 'select coalesce((select is_admin from public.profiles where id = auth.uid()), false);\n$$;'));
    await db.exec(section('alter table public.games add column if not exists created_by uuid', 'on delete set null;'));
    await db.exec(section('-- ---- helpers ----', "select public.is_admin() or public.member_role(p_league_id) = 'owner';\n$$;"));
    await db.exec(section('create or replace function public.bulk_import_roster(p_league_id', 'grant execute on function public.bulk_import_roster(text,jsonb) to authenticated;'));
    const addition = section('-- BEGIN ROSTER IMPORT RECEIPTS', '-- END ROSTER IMPORT RECEIPTS');
    await db.exec(addition);
    await db.exec(read('tests/sql/roster_import_receipts.test.sql'));
    const before = (await db.query('select * from public.players order by id')).rows;
    await db.exec(addition); // Reapplying schema additions preserves data and receipts.
    assert.deepEqual((await db.query('select * from public.players order by id')).rows, before);
    assert.equal((await db.query('select count(*)::int as n from public.roster_import_receipts')).rows[0].n, 1);
    console.log('PASS: PostgreSQL roster receipts suite and schema reapplication preserve existing data.');
  } finally { await db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
