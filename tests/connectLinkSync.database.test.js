'use strict';
// Two isolated PostgreSQL databases + the shipped migrations, worker and mobile receiver.
// HTTP is adapted to these databases; no hosted project or production data is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { PGlite } = require(process.env.ITALA_PGLITE_MODULE || '@electric-sql/pglite');
const connectRoot = process.env.ITALA_CONNECT_ROOT || path.resolve('..', 'iTala-connect-webapp');
const E = '10000000-0000-4000-8000-000000000001';
const E2 = '10000000-0000-4000-8000-000000000002';
const D = '20000000-0000-4000-8000-000000000001';
const D2 = '20000000-0000-4000-8000-000000000002';
const read = file => fs.readFileSync(file, 'utf8');
function moduleAt(file, imports = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(read(file), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, require: name => { assert.ok(name in imports, name); return imports[name]; },
    crypto: globalThis.crypto, TextEncoder, TextDecoder, Response, Request, AbortSignal, Set, Promise });
  return exports;
}
const receiver = moduleAt('supabase/functions/_shared/connectLinkState.ts');
const worker = moduleAt(path.join(connectRoot, 'src/server/mobile/link-sync-worker.ts'));
const config = { connectUrl: 'https://connect.test', connectKey: 'connect-service',
  mobileUrl: 'https://mobile.test', secret: 'test-link-delivery-secret-with-32-characters' };

(async () => {
  const connect = new PGlite(), mobile = new PGlite();
  try {
    for (const db of [connect, mobile]) await db.exec('create role anon; create role authenticated; create role service_role; grant usage on schema public to service_role;');
    await connect.exec(`
      create table events(id uuid primary key, name text not null, status text not null,
        timezone text not null default 'Pacific/Auckland', published_at timestamptz);
      create table divisions(id uuid primary key, event_id uuid references events(id) on delete cascade,
        name text not null, sort_order int not null default 0);
      create table division_mobile_links(division_id uuid primary key references divisions(id) on delete cascade, league_id text not null);
      insert into events(id,name,status) values ('${E}','Event','draft'), ('${E2}','Other event','published');
      insert into divisions(id,event_id,name) values ('${D}','${E}','Open'), ('${D2}','${E2}','Women');
      insert into division_mobile_links values ('${D}','league');
    `);
    await connect.exec(read(path.join(connectRoot, 'supabase/migrations/20261001000100_mobile_link_sync.sql')));
    await mobile.exec(read('tests/sql/harness.sql'));
    const migration = read('supabase/migrations/20261001000200_connect_link_state.sql');
    await mobile.exec(migration); await mobile.exec(migration);
    await mobile.exec(`
      insert into leagues(id,name,season,kind,created_at) values
        ('league','League','2026','league',1),('other','Other','2026','league',1);
      insert into teams(id,league_id,name,color) values ('home','league','Home','#000'),('away','league','Away','#fff');
      grant usage on schema public to authenticated,service_role;
      grant select,insert,update on leagues,games to authenticated;
    `);
    let failDelivery = false;
    const rpc = async (db, name, args) => {
      const signatures = {
        pending_mobile_link_snapshots: ['p_limit'], connect_mobile_link_snapshot: ['p_league_id'],
        ack_mobile_link_snapshot: ['p_league_id', 'p_revision'],
        apply_connect_link_snapshot: ['p_league_id', 'p_events', 'p_revision', 'p_checked_at'],
      };
      const keys = signatures[name]; assert.ok(keys, name);
      const params = keys.map(key => typeof args[key] === 'object' ? JSON.stringify(args[key]) : args[key]);
      const result = await db.query(`select public.${name}(${keys.map((_, i) => '$' + (i + 1)).join(',')}) as value`, params);
      return Response.json(result.rows[0].value ?? null);
    };
    const deps = { env: name => ({ SUPABASE_URL: config.mobileUrl, SUPABASE_SERVICE_ROLE_KEY: 'mobile-service',
      CONNECT_LINK_SYNC_SECRET: config.secret })[name], fetch: async (input, init) => {
      const name = new URL(input).pathname.split('/').pop();
      return rpc(mobile, name, JSON.parse(init.body));
    } };
    const transport = async (input, init) => {
      const url = new URL(input);
      if (url.host === 'connect.test') return rpc(connect, url.pathname.split('/').pop(), JSON.parse(init.body));
      if (failDelivery) return new Response(null, { status: 502 });
      return receiver.handleConnectLinkState(new Request(input, init), deps);
    };
    const snapshot = async leagueId => (await connect.query('select public.connect_mobile_link_snapshot($1) as s', [leagueId])).rows[0].s;
    const state = async leagueId => (await mobile.query('select connect_events,connect_link_revision,connect_link_checked_at from leagues where id=$1', [leagueId])).rows[0];
    const pending = async leagueId => (await connect.query('select pending from mobile_link_sync_queue where league_id=$1', [leagueId])).rows[0].pending;
    async function refused(db, sql, params = []) {
      await db.exec('set role authenticated');
      try { await assert.rejects(() => db.query(sql, params)); } finally { await db.exec('reset role'); }
    }

    assert.equal((await snapshot('league')).events.length, 0, 'a draft link does not activate scheduled mode');
    await connect.exec('set role service_role');
    try { assert.equal((await snapshot('league')).events.length, 0, 'the source service role can discover snapshots'); }
    finally { await connect.exec('reset role'); }
    assert.equal((await worker.syncMobileLinks(config, transport)).delivered, 1, 'existing links are backfilled');
    assert.equal((await state('league')).connect_events.length, 0);
    assert.equal(await pending('league'), false);
    await mobile.exec("insert into games(id,league_id,home_team_id,away_team_id,status) values ('ordinary','league','home','away','live')");

    await connect.exec(`update events set status='published',published_at=now() where id='${E}'`);
    const published = await snapshot('league');
    assert.equal(published.events.length, 1);
    failDelivery = true;
    assert.equal((await worker.syncMobileLinks(config, transport)).failed, 1);
    assert.equal(await pending('league'), true, 'a failed delivery remains durable');
    assert.equal((await state('league')).connect_events.length, 0, 'failed delivery preserves the previous mode');
    failDelivery = false;
    assert.equal((await worker.syncMobileLinks(config, transport)).delivered, 1);
    assert.equal((await state('league')).connect_events.length, 1);
    await refused(mobile, "insert into games(id,league_id,home_team_id,away_team_id,status) values ('stale-device','league','home','away','live')");
    await refused(mobile, "insert into games(id,league_id,home_team_id,away_team_id,status) values ('cg_forged','league','home','away','live')");
    await mobile.exec("insert into games(id,league_id,home_team_id,away_team_id,status) values ('ordinary','league','home','away','final') on conflict(id) do update set status=excluded.status");
    await mobile.exec("select authorize_connect_game('league','scheduled','home','away')");
    await mobile.exec("insert into games(id,league_id,home_team_id,away_team_id,status) values ('scheduled','league','home','away','live')");
    await refused(mobile, "update leagues set connect_events='[]' where id='league'");
    await refused(mobile, "select apply_connect_link_snapshot('league','[]',100,100)");
    await refused(mobile, "select authorize_connect_game('league','forged','home','away')");
    await refused(connect, "select connect_mobile_link_snapshot('league')");
    await refused(connect, "select * from mobile_link_sync_queue");
    await assert.rejects(() => mobile.query("select apply_connect_link_snapshot('league','[]',null,100)"), /Invalid Connect link snapshot/);
    await assert.rejects(() => mobile.query("select apply_connect_link_snapshot('league','[]',100,null)"), /Invalid Connect link snapshot/);

    await connect.exec(`update events set status='draft' where id='${E}'`);
    assert.equal((await worker.syncMobileLinks(config, transport)).delivered, 1);
    assert.equal((await state('league')).connect_events.length, 0, 'unpublishing restores ordinary game mode');
    await connect.exec(`update events set status='published' where id='${E}'; update divisions set name='Renamed division' where id='${D}'`);
    assert.equal((await snapshot('league')).events[0].divisions[0].name, 'Renamed division');
    assert.equal((await worker.syncMobileLinks(config, transport)).delivered, 1);
    assert.equal((await state('league')).connect_events.length, 1, 'republishing restores scheduled mode');

    await connect.exec(`insert into division_mobile_links values ('${D2}','league')`);
    const multiple = await snapshot('league');
    assert.equal(multiple.events.length, 2, 'multiple event links are preserved');
    await connect.exec(`update division_mobile_links set league_id='other' where division_id='${D2}'`);
    assert.equal((await snapshot('other')).events.length, 1);
    assert.equal((await snapshot('league')).events.length, 1, 'relinking updates both leagues');
    await connect.exec(`update events set name='Renamed',timezone='America/Vancouver' where id='${E}'`);
    const renamed = await snapshot('league');
    assert.equal(renamed.events[0].name, 'Renamed');
    assert.equal(renamed.events[0].timezone, 'America/Vancouver');
    await connect.exec(`delete from events where id='${E}'`);
    const deleted = await snapshot('league');
    assert.equal(deleted.events.length, 0, 'event deletion cascades still queue an unlink');
    await rpc(connect, 'ack_mobile_link_snapshot', { p_league_id: 'league', p_revision: published.revision });
    assert.equal(await pending('league'), true, 'a late acknowledgement cannot erase a newer update');
    assert.equal((await worker.syncMobileLinks(config, transport)).delivered, 2);
    assert.equal((await state('league')).connect_events.length, 0);
    await mobile.exec("insert into games(id,league_id,home_team_id,away_team_id,status) values ('regular-again','league','home','away','live')");
    await rpc(mobile, 'apply_connect_link_snapshot', { p_league_id: 'league', p_events: published.events,
      p_revision: published.revision, p_checked_at: published.checkedAt });
    assert.equal((await state('league')).connect_events.length, 0, 'a late delivery cannot re-enable a deleted event');

    await connect.exec(`delete from division_mobile_links where division_id='${D2}'`);
    assert.equal((await snapshot('other')).events.length, 0, 'explicit unlink queues an empty snapshot');
    assert.equal((await worker.syncMobileLinks(config, transport)).delivered, 1);
    assert.equal((await state('other')).connect_events.length, 0);
    const invalidRequest = new Request('https://mobile.test', { method: 'POST', body: JSON.stringify(deleted) });
    assert.equal((await receiver.handleConnectLinkState(invalidRequest, deps)).status, 401);
    assert.equal((await receiver.handleConnectLinkState(new Request('https://mobile.test', { method: 'POST',
      headers: { 'x-connect-link-secret': config.secret }, body: '{}' }), deps)).status, 400);
    assert.equal((await receiver.handleConnectLinkState(new Request('https://mobile.test', { method: 'POST',
      headers: { 'x-connect-link-secret': config.secret }, body: 'x'.repeat(131073) }), deps)).status, 413);
    console.log('✓ Two PostgreSQL databases: backfill, draft/publish, durable retry, multiple links, relink, rename, delete/unlink, stale delivery/ack, permissions, game guard, existing games and receiver authentication');
  } finally { await Promise.all([connect.close(), mobile.close()]); }
})().catch(error => { console.error(error); process.exitCode = 1; });
