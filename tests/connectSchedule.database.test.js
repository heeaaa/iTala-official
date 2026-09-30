'use strict';
// Real PostgreSQL in WASM, using the shipped mobile SQL and no live projects.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.ITALA_PGLITE_MODULE || '@electric-sql/pglite');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');
const schema = read('supabase/schema.sql');
const section = (start, end) => {
  const a = schema.indexOf(start), b = schema.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `${start} section exists`);
  return schema.slice(a, b + end.length);
};
const gameId = '66666666-6666-4666-8666-000000000001';
const rpc = (league = 'league-1', home = 'home', away = 'away', homeIds = ['p1'], awayIds = ['p2']) =>
  `select (public.start_connect_game('${league}','${gameId}','${home}','${away}',
    array[${homeIds.map(x => `'${x}'`).join(',')} ]::text[],
    array[${awayIds.map(x => `'${x}'`).join(',')} ]::text[], 'Main Court')).id as id`;

(async () => {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated;');
    await db.exec(read('tests/sql/harness.sql'));
    await db.exec(section('alter table public.games add column if not exists created_by uuid', 'on delete set null;'));
    await db.exec(section('-- ---- helpers ----', "select public.is_admin() or public.member_role(p_league_id) = 'owner';\n$$;"));
    const functionSql = section('-- START CONNECT SCHEDULE INTEGRATION', '-- END CONNECT SCHEDULE INTEGRATION');
    await db.exec(functionSql);
    await db.exec(functionSql); // migration is safe to reapply
    await db.exec(`
      insert into leagues(id,name,season,kind,is_closed,created_at) values
        ('league-1','One','2026','league',false,1),
        ('league-2','Two','2026','league',false,2),
        ('closed','Closed','2026','league',true,3);
      insert into league_members values ('league-1','11111111-1111-1111-1111-111111111111','scorekeeper');
      insert into teams(id,league_id,name,color,player_ids) values
        ('home','league-1','Home','#123456',array['p1','p3']),
        ('away','league-1','Away','#654321',array['p2']),
        ('other','league-2','Other','#abcdef',array['p4']),
        ('ch','closed','Closed home','#123456',array['p5']),
        ('ca','closed','Closed away','#123456',array['p6']);
      grant usage on schema public, auth to authenticated;
      grant select on leagues, league_members, teams, games, profiles, auth_state to authenticated;
      grant insert on games to authenticated;
      alter table games enable row level security;
      create policy games_read on games for select using (true);
      create policy games_write on games for insert with check (public.can_score(league_id));
    `);
    const asScorer = async query => {
      await db.exec('set role authenticated');
      try { return await db.query(query); } finally { await db.exec('reset role'); }
    };
    const first = await asScorer(rpc());
    assert.equal(first.rows[0].id, `cg_${gameId}`);
    const created = (await db.query(`select * from games where id='cg_${gameId}'`)).rows[0];
    assert.equal(created.status, 'live');
    assert.deepEqual(created.home_on_court, ['p1']);
    await db.exec(`update games set status='final', home_on_court=array['p3'], period=4 where id='cg_${gameId}'`);
    const retry = await asScorer(rpc('league-1', 'home', 'away', ['p1'], ['p2']));
    assert.equal(retry.rows[0].id, `cg_${gameId}`);
    assert.deepEqual((await db.query(`select status,home_on_court,period from games where id='cg_${gameId}'`)).rows[0],
      { status: 'final', home_on_court: ['p3'], period: 4 });
    async function denied(query) {
      await assert.rejects(() => asScorer(query));
    }
    await denied(rpc('league-1', 'home', 'other'));
    await denied(rpc('league-1', 'home', 'away', ['p4'], ['p2']));
    await denied(rpc('league-1', 'home', 'away', ['p1', 'p1'], ['p2']));
    await denied(rpc('closed', 'ch', 'ca', ['p5'], ['p6']));
    await db.exec("update auth_state set uid='22222222-2222-2222-2222-222222222222'");
    await denied(rpc());
    assert.equal((await db.query(`select count(*)::int as n from games where id='cg_${gameId}'`)).rows[0].n, 1);
    console.log('✓ Connect Start RPC: SQL loads twice, scorer rights, closed league, lineups, one game, retry preserves final');
  } finally { await db.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
