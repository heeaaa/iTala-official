// Optional isolated PostgreSQL/WASM verification. Set ITALA_PGLITE_MODULE to
// an installed @electric-sql/pglite module path; no production DB is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PGlite } = require(process.env.ITALA_PGLITE_MODULE || '@electric-sql/pglite');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const section = sql => sql.slice(sql.indexOf('create table if not exists public.content_reports ('), sql.indexOf('-- 6) REALTIME'));
const watchdog = setTimeout(() => { console.error('FAIL: report test did not settle'); process.exit(1); }, 30_000);
(async () => {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated;');
    await db.exec(read('tests/sql/harness.sql'));
    // Start from the actually released schema, then upgrade in place.
    const original = execFileSync('git', ['show', 'f0a96c1:supabase/schema.sql'], { cwd: root, encoding: 'utf8' });
    await db.exec(section(original));
    await db.exec("insert into leagues (id,name,season,kind,created_at) values ('old','Old','S1','league',1)");
    const call = "select public.submit_content_report('league','old','old',null,'Incorrect information',null,null) as receipt";
    await db.query(call);
    await db.query(call);
    assert.equal((await db.query('select count(*)::int as n from content_reports')).rows[0].n, 2);
    console.log('PROVED original SQL: repeating a committed report creates two rows.');
    const migration = section(read('supabase/schema.sql'));
    await db.exec(migration);
    await db.exec(migration); // safe to reapply
    assert.equal((await db.query('select count(*)::int as n from content_reports')).rows[0].n, 2);
    await db.exec('delete from content_reports');

    console.log('PASS: PostgreSQL SQL suite, migration from PR #34, reapplication and existing-row preservation.');

    const stable = "select public.submit_content_report('league','old','old',null,'Incorrect information',null,null,'lost-reply') as receipt";
    const first = (await db.query(stable)).rows[0].receipt; // commit, pretend reply was lost
    await assert.rejects(db.query(stable.replace("'Incorrect information'", "'Other privacy concern'")), /different content/);
    // Normalization must match the original insert, including optional blanks.
    const normalized = (await db.query(stable.replace("null,null,'lost-reply'", "'  ','  ','lost-reply'"))).rows[0].receipt;
    assert.deepEqual(normalized, first);
    const results = await Promise.all([db.query(stable), db.query(stable)]);
    assert.ok(results.every(r => JSON.stringify(r.rows[0].receipt) === JSON.stringify(first)));
    assert.equal((await db.query("select count(*)::int as n from content_reports where request_id='lost-reply'")).rows[0].n, 1);
    assert.equal((await db.query("select count(*)::int as n from pg_proc where proname='submit_content_report'")).rows[0].n, 1);
    await db.exec("update auth_state set uid = '22222222-2222-2222-2222-222222222222', anon = true");
    const anotherUser = (await db.query(stable)).rows[0].receipt;
    assert.notEqual(anotherUser.reference, first.reference);
    await db.query(call); await db.query(call); // legacy seven-argument clients
    assert.equal((await db.query('select count(*)::int as n from content_reports')).rows[0].n, 4);
    console.log('PASS: guest reporting, reporter isolation and legacy seven-argument clients.');
    await db.exec('update auth_state set uid = null');
    await assert.rejects(db.query(call), /An app session is required/);
    const rights = (await db.query("select has_table_privilege('anon','content_reports','SELECT') as read, has_table_privilege('authenticated','content_reports','INSERT') as write")).rows[0];
    assert.equal(rights.read, false); assert.equal(rights.write, false);
    console.log('PASS: lost-response retries return one receipt/row; no-session rejection and private table grants preserved.');
  } finally { await db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
