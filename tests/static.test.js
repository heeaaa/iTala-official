const fs = require('fs');
const path = require('path');
const ROOT = process.env.ITALA_ROOT || require('path').join(__dirname, '..');

let pass = 0, fail = 0, warn = 0;
const problems = [], warnings = [];
const ok = (n, c, d) => c ? pass++ : (fail++, problems.push(`${n}${d ? ' :: ' + d : ''}`));
const soft = (n, c, d) => c ? pass++ : (warn++, warnings.push(`${n}${d ? ' :: ' + d : ''}`));

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
// Repo-relative existence check, used by the doc-link check (CHECK 22).
const exists = f => fs.existsSync(path.join(ROOT, f));
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

// Every screen needs a human `title`, whatever its header renders.
//
// On iOS the native stack labels the back button with the PREVIOUS screen's
// `title` and falls back to the ROUTE NAME when there isn't one. Route names
// are PascalCase code identifiers, so the top-left of the screen read
// "LeagueDetail". `headerTitle` (the brand wordmark on most screens) overrides
// what the header draws but is not a label, so it never covered this.
for (const m of app.matchAll(/<Stack\.Screen\s+name="(\w+)"[^>]*?options=\{([\s\S]*?)\}\s*\/>/g)) {
  ok(`screen "${m[1]}" has a human title`, /title:\s*'[^']+'/.test(m[2]),
     'without one iOS labels the back button with the route name');
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
// Both boundaries are checked. This slice used to end at `const defaultSettings`,
// and when that constant was deleted indexOf returned -1, so slice(start, -1)
// silently truncated the union: the check would still report "pass" while
// verifying almost nothing. Fail loudly instead.
const unionStart = store.indexOf('export type Action =');
const unionEnd = store.indexOf('const initial: AppState');
if (unionStart < 0 || unionEnd < 0) {
  console.error('FATAL: could not locate the Action union boundaries in StoreProvider.tsx');
  process.exit(2);
}
const actionUnion = store.slice(unionStart, unionEnd);
const actions = [...actionUnion.matchAll(/t:\s*'([A-Z_]+)'/g)].map(m => m[1]);
ok('action union parsed', actions.length > 20, `found ${actions.length}`);
const reducerBody = store.slice(store.indexOf('export function reducer'));
for (const a of actions) {
  if (a === 'HYDRATE') continue;
  ok(`reducer handles ${a}`, reducerBody.includes(`case '${a}'`), 'no case in reducer');
}
// sync coverage: local-only actions legitimately have no server write
const localOnly = new Set(['HYDRATE']);
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
ok('docs/DEPLOYMENT.md keeps the zip-apply commands', read('docs/DEPLOYMENT.md').includes('Expand-Archive'));

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
  const pend = read('src/sync/pendingEvents.ts');

  ok('dispatch stamps event ids before reducing',
     /stampActionIds\(\s*stateRef\.current/.test(store),
     'the reducer, the push and the ledger must all name the same row');
  ok('dispatch records the write in the pending ledger',
     /recordPending\(action, prev, next\)/.test(store),
     'without a ledger entry a snapshot older than the tap overwrites it');
  ok('the ledger is given both sides of the change, not just the result',
     /const prev = stateRef\.current;/.test(store) && /const next = reducer\(prev, action\)/.test(store),
     'the game-row half of the ledger is found by diffing prev against next');
  // `failPending` also takes the reason now, so the outbox can carry why the
  // last attempt was rejected. The argument is optional in the signature and
  // matched loosely here: what this check is for is that BOTH sides are wired,
  // not how many arguments they take.
  ok('a settled push tells the ledger which way it went',
     /confirmPending\(pushTokens\)/.test(store) && /failPending\(pushTokens\b/.test(store),
     'an entry that is never confirmed pins forever; one confirmed on failure loses the stat');
  ok('the ledger settles by push token, not by bare event id',
     /const pushTokens = (SYNC_ENABLED \? )?recordPending\(/.test(store) &&
     /eventToken = \(op: 'add' \| 'remove', eventId: string\)/.test(pend),
     "an add and the undo of the same row shared one slot, so the INSERT's " +
     "acknowledgement retired the UNDO and the basket came back");
  ok('every server hydrate carries the tick its fetch started at',
     !/baseDispatch\(\{ t: 'HYDRATE', state: \{ leagues: remote\.leagues \} \}\)/.test(store) &&
     !/baseDispatch\(\{ t: 'HYDRATE', state: \{ leagues \} \}\)(?!.*snapshotAt)/.test(store),
     "a HYDRATE without snapshotAt skips reconciliation and clobbers pending writes");
  ok('the snapshot tick is taken before the fetch, not after',
     /const at = beginSnapshot\(\);\s*\n\s*const remote = await fetchAllState/.test(store),
     'a tick taken after the read would make a stale snapshot look current');
  ok('HYDRATE reconciles events against the ledger',
     /reconcileLeagueEvents\(l\.id, l\.events, a\.snapshotAt\)/.test(store));
  ok('HYDRATE reconciles the game rows too',
     /reconcileLeagueGames\(l\.id, migrated\.games, a\.snapshotAt, localLeagues\.get\(l\.id\)\?\.games\)/.test(store),
     'lineups, substitutions and the period need the same ordering guarantee as a basket, '
     + 'and the local rows are what stops a pinned write resurrecting a rolled-back game');
  ok('the clock-based lineup guard is gone',
     !/LINEUP_GUARD_MS|isLineupGuarded/.test(store),
     'a timed tombstone is too short for a slow push and wrong once it expires');

  // ---- one owner for every server pull -----------------------------------
  // Five uncoordinated pull sites (boot, boot retry, post-auth re-pull, the
  // realtime refetch, pull-to-refresh) is all it takes to lose a committed stat:
  // the older reply wins by arriving last, after the newer one has legitimately
  // retired the ledger entry protecting the write.
  ok('there is exactly one place that fetches server state',
     (store.match(/await fetchAllState\(/g) ?? []).length === 1,
     'concurrent pulls deliver out of order and the older reply wins');
  ok('every pull goes through the single owner',
     /const pullState = useCallback\(/.test(store) &&
     /pullState\('boot'\)/.test(store) && /pullState\('boot-retry'\)/.test(store) &&
     /pullState\('realtime'\)/.test(store) && /pullState\('manual-refresh'\)/.test(store) &&
     /pullState\(`auth:\$\{event\}`\)/.test(store));
  ok('a pull requested while one is running queues a follow-up',
     /gate\.trailing = true/.test(store) && /\} while \(gate\.trailing\)/.test(store),
     'dropping it leaves the device holding a snapshot older than the change that asked for it');
  ok('a snapshot older than one already applied is refused',
     /if \(!acceptSnapshot\(at\)\)/.test(store) &&
     /snapshotStarted <= appliedAt/.test(pend),
     'this is the out-of-order revert the ledger alone cannot catch');

  // ---- the outbox: the ledger has to survive the process -----------------
  // The ledger protected a failed write inside one run of the app and nothing
  // else: no retry, and a Map that died with the process. So a stat logged
  // offline stayed on the device, was never re-sent after reconnecting, and was
  // DELETED on the next launch — the boot pull hydrated the server's rows
  // through an empty ledger and the autosave wrote that over the durable copy.
  // Each of these is one link in the chain that closes it.
  const storage = read('src/store/storage.ts');
  ok('the outbox is written to disk',
     /export async function saveOutbox\(/.test(storage) && /outboxSnapshot\(\)/.test(store),
     'a queue that only exists in memory loses everything the moment the app closes');
  ok('the outbox is restored BEFORE the first server pull',
     store.indexOf('restoreOutbox(') > 0 &&
     store.indexOf('restoreOutbox(') < store.indexOf("pullState('boot')"),
     'restored after, the boot snapshot has already deleted the writes it was meant to protect');
  ok('a restored entry is unconfirmed, so no snapshot may overwrite it',
     /confirmedAt: null,/.test(pend) && /export function restoreOutbox\(/.test(pend),
     'the whole point of restoring is to make reconciliation keep the local rows');
  ok('reconnecting drains the outbox',
     /const drainOutbox = useCallback\(/.test(store) &&
     /net !== 'online'\) return;[\s\S]{0,140}?drainOutbox\('reconnect'\)/.test(store),
     'without a drain, reconnecting sends nothing and only the NEXT tap reaches the server');
  ok('replay is idempotent, so a retry cannot duplicate a stat',
     /export async function pushPendingEntry\(/.test(sync) &&
     /REPLAY_events', await sb\.from\('events'\)\.upsert\(/.test(sync),
     'an insert would reject as a duplicate key on a write that actually landed');
  ok('a drain marks entries in flight so nothing is sent twice',
     /beginPush\(\[entry\.token\]\)/.test(store) && /export function beginPush\(/.test(pend),
     'reconnect, foreground and pull-to-refresh can all ask at once');
  ok('the outbox is pruned of games the device no longer has',
     /pruneOutbox\(localGameIds\)/.test(store) && /export function pruneOutbox\(/.test(pend),
     'replaying a write for a rolled-back or deleted game re-creates it on the server');
  ok('but a queued insert is never pruned by local absence',
     !/localEventIds/.test(pend),
     'the outbox is written before the state, so an entry can legitimately '
     + 'outlive the saved row - and it holds the last copy of it');
  ok('nothing in the outbox is discarded for being old',
     !/MAX_OUTBOX_AGE|OUTBOX_TTL|expires/.test(pend),
     'an outbox that throws work away to stay tidy is the timeout bug in a new costume');

  // ---- connectivity is observed, not assumed -----------------------------
  // `synced` is SYNC_ENABLED — a build-time constant that said "Connected" in
  // aeroplane mode. Reachability is a different question and has to be asked.
  const conn = read('src/sync/connectivity.ts');
  ok('reachability is observed on both the pull and the push path',
     (store.match(/noteReachable\(\)/g) ?? []).length >= 2 &&
     (store.match(/noteUnreachable\(/g) ?? []).length >= 2,
     'a status derived from one path is blind to the other');
  ok('offline is only ever KNOWN, never guessed',
     /status === 'offline'/.test(conn) && /let status: NetStatus = 'unknown'/.test(conn),
     "'unknown' must not refuse a refresh nobody has tried yet");
  ok('a known-offline refresh does not fire five table reads',
     /if \(isKnownOffline\(\)\)/.test(store),
     'the request cannot succeed and its failure is what the user already reported');
  ok('a dead connection is probed until it answers',
     /pingServer\(sb\)/.test(store) && /probeDelay\(probeAttempts\.current\)/.test(store),
     'a device with nothing to send generates no evidence of its own recovery');

  // ---- the three ways a lost connection was reported as a healthy one ----
  // Every one of these was green in this suite while the app did the opposite,
  // because the emulator THREW where @supabase/postgrest-js RESOLVES. Verified
  // against the installed client: a select and an upsert against an unreachable
  // host both come back as { data: null, error, status: 0 }, with no throw.
  ok('a transport failure is classified from the response, not from a throw',
     /function transportFailure\(/.test(sync) && /res\.status === 0/.test(sync),
     'the client resolves a dead request, so a catch block never sees it');
  ok('the swallowing helper rethrows a transport failure',
     /function check\(label: string, res: \{ error: any; status\?: number \}\): void \{[\s\S]{0,400}?const transport = transportFailure\(res\);[\s\S]{0,200}?throw new Error/.test(sync),
     'SET_LINEUP, SUBSTITUTE, SET_PERIOD, SET_GAME_STATUS and SET_ATTENDANCE all '
     + 'push through check, so a swallowed transport failure reported them saved');
  ok('a row-level rejection still reconverges rather than interrupting a game',
     /warn\(`\[sync\] \$\{label\} rejected:`/.test(sync),
     'only the transport changed behaviour; RLS refusals keep the old path');
  ok('pingServer decides from the response it got back',
     /const res = await sb\.from\('leagues'\)\.select\('id'\)\.limit\(1\);/.test(sync) &&
     /return transportFailure\(res\) === null;/.test(sync),
     'the old catch answered true in aeroplane mode, so Settings said Connected');
  ok('fetchAllState tells a dead request apart from a bad read',
     /throw new Error\(`fetch \$\{what\}: \$\{transport\}`\)/.test(sync) &&
     /if \(lr\.error\) \{ warn\('\[sync\] fetch leagues error:'[\s\S]{0,60}?return null; \}/.test(sync),
     'null for both made pullState record a read that never left the device as reachable');
  ok('the pull records reachability only after a read genuinely came back',
     /const remote = await fetchAllState\(sb\);[\s\S]{0,600}?noteReachable\(\);/.test(store) &&
     /noteUnreachable\(e\);/.test(store),
     'a throw from fetchAllState has to reach the catch, not the reachable line');
  ok('both spellings of the transport failure classify the same',
     /network request failed\|failed to fetch\|fetch failed\|network error/.test(read('src/store/authErrors.ts')),
     'React Native says Network request failed; Node and undici say fetch failed');
  ok('the probe backoff outlives the effect that runs it',
     /const probeAttempts = useRef\(0\)/.test(store) &&
     /probeAttempts\.current\+\+;\s*\n\s*const answered = await pingServer/.test(store),
     'a counter inside the effect body restarts at zero on every status flip, so '
     + 'the schedule never leaves its first step');
  ok('the backoff is cleared only once the connection carried the queue',
     /await drainOutbox\('reconnect'\);[\s\S]{0,400}?if \(!isKnownOffline\(\)\) probeAttempts\.current = 0;/.test(store),
     'clearing it on the ping alone re-opens the two-second loop on a host that '
     + 'answers reads and drops writes');

  // ---- a build with no server must not keep a queue it can never drain ---
  // SYNC_ENABLED is !!(URL && ANON_KEY), and the README documents running with
  // neither. Nothing in such a build confirms, pulls, retires or sends, so every
  // recorded entry stayed unconfirmed: the ledger filled to MAX_ENTRIES and each
  // stat tap after that sorted 1000 entries and serialised ~250 KB to storage,
  // on the live-scoring tap path, for a queue with nowhere to go.
  ok('the pending ledger is only built when there is a server to confirm it',
     /const pushTokens = SYNC_ENABLED \? recordPending\(action, prev, next\) : \[\];/.test(store),
     'a local-only build recorded a write nothing could ever confirm or drain');
  ok('and a persisted outbox is not restored into a build that cannot drain it',
     /if \(!cancelled && SYNC_ENABLED\) \{\s*\n\s*const restored = restoreOutbox\(/.test(store),
     'restoring pins writes forever and reports a queue depth nobody can act on');
  // The reducer body, from its declaration to the context type that follows it.
  const reducerFrom = store.indexOf('export function reducer');
  const reducerTo = store.indexOf('interface Ctx {');
  const reducerBody = reducerFrom >= 0 && reducerTo > reducerFrom
    ? store.slice(reducerFrom, reducerTo) : '';
  ok('the reducer body was locatable', reducerBody.length > 0,
     'the two checks below inspect it and would silently pass on an empty string');
  ok('the watermark is claimed outside the reducer',
     !/acceptSnapshot/.test(reducerBody),
     'React may run a reducer more than once for the same action, and claiming '
     + 'the watermark twice would reject the second run');
  // Scoped to the EVENT timestamp on purpose. The reducer also reads the clock
  // for `createdAt`, `scheduledAt` and `finishedAt`, which drift by a
  // millisecond between the two runs in exactly the same way - but the server's
  // value for those wins on the next hydrate and nothing compares them for
  // equality, whereas `ts` is half of the (ts, id) key that decides which row
  // Undo removes on each side. That one has to come off the action.
  ok('no event timestamp comes from a bare clock read in the reducer',
     !/ts: Date\.now\(\)/.test(reducerBody),
     'the reducer runs twice per action, so the pushed row and the rendered row '
     + 'would disagree on the key that defines "the last event of this game"');
  ok('an empty read never wipes a device that has data',
     /leagues\.length === 0 && stateRef\.current\.leagues\.length > 0/.test(store),
     'an RLS read mid token-refresh returns [] rather than an error');
  ok('a token refresh does not trigger a re-pull',
     /event !== 'SIGNED_IN' && event !== 'USER_UPDATED'/.test(store),
     'TOKEN_REFRESHED is periodic and says nothing about the data');
  ok('ADD_EVENT is stamped once, at dispatch, not per reducer run',
     /ts: action\.ts \?\? Math\.max\(Date\.now\(\)/.test(store) &&
     /ts: a\.ts \?\? Date\.now\(\)/.test(store),
     'the reducer runs twice per action, so Date.now() inside it gave the server '
     + 'row and the on-screen row different timestamps');
  ok('the ledger retires an entry by ordering, not by a timeout',
     /confirmedAt !== null && e\.confirmedAt < snapshotStarted/.test(pend) &&
     !/GUARD_MS|Date\.now\(\) \+/.test(pend),
     'a time window is both too short for a slow push and too long for a failed one');
  // The (ts, id) order used to be asked of the server. It is now imposed on the
  // rows in hand, because the read pages by `id` - a cursor the server's display
  // order cannot be shifted under (see readAll). The INVARIANT is unchanged and
  // still asserted: both sides must name the same row as "the last event of this
  // game", or Undo removes a different one from the two.
  ok('the pull walks a stable key rather than an OFFSET window',
     /\.order\('id'\)\.limit\(limit\)/.test(sync) && /\.gt\('id', after\)/.test(sync),
     'OFFSET is defined against a result set other devices are changing; a delete '
     + 'behind the cursor makes the next window step over a surviving row');
  // Comments stripped: readAll's own documentation names `.range(from, to)` when
  // explaining what it replaced, and an assertion that cannot tell prose from
  // code would be satisfied by a file that talks about the rule while breaking
  // it. Crude but sufficient for these files - no regex literal here contains a
  // comment opener.
  const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ok('and never asks for a row window',
     !/\.range\(/.test(codeOf(sync)),
     'a .range() read reintroduces the offset skip this replaced');
  ok('events are put in (ts, id) order before they are handed over',
     /const byTsThenId =/.test(sync) && /\.sort\(byTsThenId\)/.test(sync),
     'ts alone ties, and Undo means "the last event" - the two sides must agree');
  ok('the client sorts by the same key',
     /a\.ts !== b\.ts/.test(pend) && /a\.id < b\.id/.test(pend));
  ok('a completed page walk is proved by an empty reply, not a short one',
     /batch\.length === 0/.test(sync) && /complete = true/.test(sync) && /if \(!complete\)/.test(sync),
     'a project whose db-max-rows is below PAGE_SIZE answers every page short; '
     + 'reading that as the end is the original truncation');
  ok('a page cursor that does not advance is an error, not a short snapshot',
     /did not advance/.test(sync),
     'a server that ignores .gt would otherwise be walked for ever, or quietly '
     + 'yield a prefix');
  ok('the undo delete asks for the deleted rows back',
     /delete\(\)\.eq\('id', action\.eventId\)\.select\(/.test(sync),
     'PostgREST reports success for a delete that RLS filtered to nothing');
  ok('a failed event write is surfaced, not logged',
     /MUST_NOT_FAIL_SILENTLY/.test(sync) &&
     /'ADD_EVENT', 'REDO_EVENT', 'UNDO_EVENT', 'DELETE_EVENT'/.test(sync),
     'a swallowed INSERT tells the ledger the server has a stat it does not');
  ok('the rethrow is keyed off the action, not the message text',
     /MUST_NOT_FAIL_SILENTLY\.has\(action\.t\)/.test(sync),
     'a network TypeError carries no label for a message test to match');
  ok('a failed all-or-nothing bundle is rolled back locally',
     /t: 'ROLLBACK_BUNDLE'/.test(store) && /reducer\(stateRef\.current, rollback\)/.test(store),
     'a half-created drop-in game that only exists locally refuses every later write');
  ok('the rollback only drops the league when this action created it',
     /removeLeague: isGame && !!action\.ensureLeague/.test(store),
     'otherwise a failed game takes an existing space and its history with it');
  ok('event pushes look their row up by id, never by position',
     !/events\[l\.events\.length - 1\]/.test(sync),
     'canonical ordering means the row an action created is not always last');
}

// ---------------------------------------------------------------------------
// CHECK 9b — the play-by-play sheet.
//
// No render harness exists for this screen, so these are structural: they check
// the two properties the sheet is required to have, and would fail if either
// were removed. Behaviour beyond this is on the manual regression list.
// ---------------------------------------------------------------------------
{
  const row = read('src/components/PlayLog.tsx');
  const live = read('src/screens/LiveGameScreen.tsx');
  const box = read('src/screens/BoxScoreScreen.tsx');

  ok('deleting a play asks first',
     /Alert\.alert\(\s*'Delete this play\?'/.test(row) &&
     /onPress: \(\) => onDelete\(event\.id\)/.test(row),
     'the row X sits millimetres from the row and rewrites the score on the first tap');
  ok('the X is wired to the confirmation, not straight to the delete',
     /onPress=\{confirmDelete\}/.test(row) &&
     !/onPress=\{\(\) => onDelete\(/.test(row));
  ok('the confirmation names the play it is about',
     /\$\{full\}/.test(row),
     '"Delete this play?" alone does not tell the user which one');
  ok('every play-by-play row shows which team it belongs to',
     /<TeamBadge logo=\{team\.logo\} color=\{team\.color\} size=\{14\} \/>/.test(row),
     'the side was previously inferable only from the player name');
  ok('the team is named, not only coloured',
     /\{team\.name\}/.test(row),
     'colour alone fails a colour-blind scorekeeper and two same-palette drop-in teams');
  ok('the delete label reads out the team too',
     /accessibilityLabel=\{`Delete \$\{full\}`\}/.test(row));

  // BOTH lists must go through it. They previously held byte-identical copies of
  // the label map and the row, so a change to one silently left the other behind
  // - which is how the live sheet and the box score could disagree about what a
  // play says or whether deleting it asks first.
  for (const [name, src] of [['LiveGameScreen', live], ['BoxScoreScreen', box]]) {
    ok(`${name} renders the play log through PlayLogRow`, /<PlayLogRow\b/.test(src),
       'a second copy of the row drifts from this one');
    ok(`${name} has no private play-by-play label map`,
       !/_LABEL: Record<EventType, string>/.test(src),
       'PLAY_LABEL in components/PlayLog.tsx is the only vocabulary');
  }
}

// ---------------------------------------------------------------------------
// CHECK 10 — no plaintext admin password anywhere in the tree.
// ---------------------------------------------------------------------------
// The admin password must live only in the database, as a hash. A literal in the
// client is shipped in the JS bundle; a literal in schema.sql is published in the
// repo. Neither is recoverable once committed, so this check is the guard.
{
  const files = ['supabase/schema.sql', 'src/store/AdminProvider.tsx', 'README.md',
                 'docs/DEPLOYMENT.md', 'docs/AUTH_SETUP.md', 'app.json', '.env.example'];
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
// CHECK 24 - the server's own words never reach a user.
//
// `describeSyncFailure` used to end in `return msg`, so any failure it did not
// recognise put raw PostgREST text on screen - `new row violates row-level
// security policy for table "events"` and the like. That names internal tables,
// tells a scorekeeper nothing they can act on, and is alarming courtside. The
// technical wording is still kept, for a developer, behind isDevBuild().
// ---------------------------------------------------------------------------
{
  const store = read('src/store/StoreProvider.tsx');
  const from = store.indexOf('function describeSyncFailure');
  const to = store.indexOf('function technicalSyncDetail');
  const body = from >= 0 && to > from ? store.slice(from, to) : '';
  ok('describeSyncFailure was locatable', body.length > 0,
     'the checks below inspect it and would pass on an empty string');
  ok('describeSyncFailure never returns the raw server message',
     !/return msg;/.test(body),
     "an unrecognised failure must fall back to a sentence, not to PostgREST's wording");
  ok('every branch of describeSyncFailure returns a string literal',
     !/return\s+(?!['"])\S/.test(body),
     'a returned variable is how the server’s wording leaks out; every branch has '
     + 'to be a sentence written here');
  ok('the technical detail is gated on a development build',
     /function technicalSyncDetail[\s\S]{0,240}if \(!isDevBuild\(\)\) return null;/.test(store),
     'a release build must not carry policy or table names into the UI');
  ok('the live tracker labels the technical detail as such',
     /Technical detail \(development build\)/.test(read('src/screens/LiveGameScreen.tsx')),
     'if it is shown at all it must be marked as not-for-users');
}

// ---------------------------------------------------------------------------
// CHECK 23 - a horizontal ScrollView that says `flexGrow: 0` must also say
// `flexShrink: 0`.
//
// React Native's ScrollView applies `flexGrow: 1, flexShrink: 1` of its own
// (Libraries/Components/ScrollView/ScrollView.js, `baseHorizontal`), so
// `flexGrow: 0` overrides the GROW half only and the element stays shrinkable.
// The intent is always "size to content", and half of it silently did not hold:
// Home's live carousel was squeezed to about 83pt for a card whose content needs
// about 101, and `overflow: 'scroll'` sliced "LIVE NOW" along the card's top
// border and the location along the bottom. Every other child of that column is
// a plain View, which defaults to flexShrink: 0, which is why the live card was
// the only thing that clipped.
//
// A rendering test would catch this and the project has no renderer, so the
// invariant is enforced on the source instead.
// ---------------------------------------------------------------------------
{
  for (const file of ['src/screens/LeaguesScreen.tsx', 'src/screens/LeagueDetailScreen.tsx']) {
    const src = read(file);
    // Every `flexGrow: 0` in a style object, with the surrounding braces, so the
    // check reads the same object that would carry the flexShrink.
    const objects = src.match(/\{[^{}]*flexGrow:\s*0[^{}]*\}/g) ?? [];
    for (const obj of objects) {
      ok(`${file.split('/').pop()} pairs flexGrow: 0 with flexShrink: 0`,
         /flexShrink:\s*0/.test(obj),
         `"${obj.trim().slice(0, 70)}" - RN's ScrollView sets flexShrink: 1 itself, so `
         + 'grow: 0 alone leaves it shrinkable and its content gets clipped');
    }
  }
}

// ---------------------------------------------------------------------------
// CHECK 15 - the privacy policy must keep covering what the store declarations
// depend on. Three things describe the same behaviour and must not disagree:
// what the code does, the policy in site/privacy/, and the Apple/Google tables
// in docs/DEPLOYMENT.md. The policy is the one nobody re-reads, so deleting a
// section from it fails the build instead of going unnoticed until a store
// review or a removal request.
//
// These are presence checks on prose, not proof the prose is accurate. They stop
// a section vanishing; they cannot stop it becoming wrong.
// ---------------------------------------------------------------------------
{
  const policyPath = 'site/privacy/index.html';
  const policyExists = exists(policyPath);
  ok('a privacy policy exists in the repo', policyExists,
     'both stores require a reachable policy URL, and it has to live somewhere version-controlled');
  if (policyExists) {
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

    // The policy is a published legal document with a store listing pointing at
    // it. It shipped with deliberate placeholders and a visible draft notice so
    // it could not go live half-finished by accident; now that it is filled in,
    // these keep it that way. A reachable contact address is the mechanism by
    // which someone who never installed the app gets their name removed, so an
    // unfilled placeholder here is a compliance failure, not a typo.
    for (const ph of ['[OPERATOR]', '[CONTACT EMAIL]']) {
      ok(`privacy policy has no ${ph} placeholder left`, !policy.includes(ph),
         'the published policy must name a real operator and a real contact address');
    }
    ok('privacy policy no longer carries the pre-publication notice',
       !/class="todo"/.test(policy) && !/Before publishing:/.test(policy),
       'the draft banner must not appear on the live page');
    ok('privacy policy gives a contact address',
       /mailto:/.test(policy),
       'section 13 must offer a way to actually reach the operator');
  }

  // The declarations in docs/DEPLOYMENT.md are the other half of the same pair.
  const deploy = read('docs/DEPLOYMENT.md');
  ok('docs/DEPLOYMENT.md declares the promo tap counter as Usage Data',
     /Usage Data → Advertising Data/.test(deploy) && /bump_promo_tap/.test(deploy),
     'server-side promo taps are collected and have to appear on both store forms');
  ok('docs/DEPLOYMENT.md tells you not to declare Location',
     /Do not declare Location/.test(deploy),
     'the venue field is user-typed text, and declaring device location would be false');
  ok('docs/DEPLOYMENT.md still refuses "Data Not Collected"',
     /does collect data/.test(deploy));
}


// ---------------------------------------------------------------------------
// CHECK 14 - accessibility floor. The app shipped with exactly one
// accessibilityLabel across nineteen screens, and the live two-tap stat flow
// announced nothing at all, which made its single most-used interaction
// effectively unusable with a screen reader. These checks are structural, not
// behavioural: they cannot prove VoiceOver reads something sensible, only that
// the semantics have not been quietly deleted again. On-device VoiceOver and
// TalkBack testing is still required and is not automatable here.
// ---------------------------------------------------------------------------
{
  const ui = read('src/components/ui.tsx');
  for (const [name, needle] of [
    ['Button', 'accessibilityRole="button"'],
    ['Segmented', 'accessibilityRole="tab"'],
    ['Toggle', 'accessibilityRole="checkbox"'],
  ]) {
    ok(`ui.tsx ${name} declares an accessibility role`, ui.includes(needle),
       'screen readers cannot tell the element is actionable without one');
  }
  ok('ui.tsx Card forwards accessibilityActions',
     /accessibilityActions\?:/.test(ui) && /onAccessibilityAction\?:/.test(ui),
     'a row whose only secondary action is a swipe is unreachable without it');

  const live = read('src/screens/LiveGameScreen.tsx');
  ok('LiveGameScreen announces to screen readers',
     /AccessibilityInfo\.announceForAccessibility/.test(live),
     'arming and logging a stat has no other non-visual confirmation');
  ok('LiveGameScreen announces both arming and logging',
     /armed\. Tap a/.test(live) && /logged for/.test(live),
     'both taps of the two-tap flow need spoken confirmation, not just one');
  ok('LiveGameScreen stat pad exposes its armed state',
     /accessibilityState=\{\{ selected: on \}\}/.test(live),
     'armed is conveyed by a background-colour swap and nothing else');
  ok('LiveGameScreen player chips carry a spoken label',
     /accessibilityLabel=\{spoken\}/.test(live),
     'the chip renders as disconnected fragments (#17, 13, PTS, 4 PF) otherwise');

  const games = read('src/screens/GamesOnDateScreen.tsx');
  ok('GamesOnDateScreen offers a non-gesture delete',
     /accessibilityActions=/.test(games) && /'delete'/.test(games),
     'delete was reachable only by a left-swipe, which screen readers intercept');
}


// ---------------------------------------------------------------------------
// CHECK 16 - lint tooling must exist and CI must run it (F-09). The project had
// no ESLint or Prettier config at all, so there was no lint step a workflow
// could even have called. These checks guard the three parts that make the gate
// real: the config, the script, and a workflow that actually invokes it. A
// config with no CI step is decoration.
//
// Structural only: they cannot tell whether the rules are good, just that the
// gate has not been quietly removed.
// ---------------------------------------------------------------------------
{
  const hasFlat = fs.existsSync(path.join(ROOT, 'eslint.config.js'));
  ok('an ESLint config exists', hasFlat,
     'without one there is no lint step CI could run - F-09');

  if (hasFlat) {
    const cfg = read('eslint.config.js');
    ok('the ESLint config builds on eslint-config-expo',
       /eslint-config-expo/.test(cfg),
       'the shared Expo config is what supplies the React Hooks and RN-aware rules');
    ok('eslint-config-prettier is applied so the two tools cannot disagree',
       /eslint-config-prettier/.test(cfg),
       'without it ESLint and Prettier fight over the same lines');
    // The whole point of the F-09 cleanup was to start from zero violations so
    // this rule can gate. If someone drops it back to a warning, CI goes green
    // on new dead code again.
    ok('unused symbols are an error, not a warning',
       /'@typescript-eslint\/no-unused-vars':\s*\['error'/.test(cfg),
       'as a warning it does not fail CI, and dead imports accumulate again');
    // Held open as a warning while F-14 was outstanding; promoted once the two
    // violations were fixed. As a warning it does not fail CI, so a memo could
    // start depending on app-wide `state` again without anything objecting -
    // which is exactly how F-14 survived unnoticed.
    ok('react hook dependencies are an error, not a warning',
       /'react-hooks\/exhaustive-deps':\s*'error'/.test(cfg),
       'F-14 is fixed, so this gate should stay closed');
    // Two React rules are switched OFF for the provider suite's hook runtime,
    // which IMPLEMENTS hooks rather than calling them. That exemption is only
    // safe while it stays scoped: widened to '**/*.tsx', or folded into the
    // block above, it would silently remove the gate from src/** while both
    // text checks above still passed - the 'error' line would still be sitting
    // there, overridden by a later entry. Flat config is last-wins, so the text
    // of one entry proves nothing on its own.
    //
    // So load the config and inspect the SCOPE of every exemption. A load
    // failure is reported as a failure rather than skipped: a check that
    // silently stops running is the shape of problem this file exists to catch.
    let entries;
    try { entries = require(path.join(ROOT, 'eslint.config.js')); }
    catch (e) { entries = e; }
    ok('the ESLint config can be loaded, so its rule scoping can be checked',
       Array.isArray(entries),
       `require('eslint.config.js') failed: ${entries && entries.message}`);
    if (Array.isArray(entries)) {
      const gated = [
        'react-hooks/exhaustive-deps',
        'react-hooks/rules-of-hooks',
        'react/no-deprecated',
        '@typescript-eslint/no-unused-vars',
        'no-unused-vars',
      ];
      const isOff = v => v === 'off' || v === 0
        || (Array.isArray(v) && (v[0] === 'off' || v[0] === 0));
      const wide = [];
      for (const entry of entries) {
        const rules = (entry && entry.rules) || {};
        for (const name of gated) {
          if (!isOff(rules[name])) continue;
          // 'no-unused-vars' is deliberately off everywhere, superseded by the
          // TypeScript-aware rule of the same name. Only flag it if THAT one is
          // off in the same entry, which would leave nothing checking at all.
          if (name === 'no-unused-vars' && !isOff(rules['@typescript-eslint/no-unused-vars'])) continue;
          const files = [].concat(...[].concat(entry.files || [])).map(String);
          if (!files.length || !files.every(f => f.startsWith('tests/'))) {
            wide.push(`${name} is off for ${files.length ? files.join(' + ') : 'EVERY file'}`);
          }
        }
      }
      ok('every rule exemption is scoped to tests/, never to src/**',
         wide.length === 0,
         `${wide.join(' | ')} - src/** must keep the rules it has today; ` +
         'exempt the harness path, not the rule');
    }
  }

  const pkg = JSON.parse(read('package.json'));
  ok('package.json exposes a lint script', typeof pkg.scripts?.lint === 'string',
     'CI and contributors must run the same command');
  ok('ESLint and Prettier are devDependencies, not runtime dependencies',
     !!pkg.devDependencies?.eslint && !!pkg.devDependencies?.prettier
       && !pkg.dependencies?.eslint && !pkg.dependencies?.prettier,
     'lint tooling must never ship in the app bundle');

  const wfDir = path.join(ROOT, '.github', 'workflows');
  const bodies = fs.existsSync(wfDir)
    ? fs.readdirSync(wfDir).filter(f => /\.ya?ml$/.test(f))
        .map(f => fs.readFileSync(path.join(wfDir, f), 'utf8'))
    : [];
  const linter = bodies.find(b => /run:\s*npm run lint\b/.test(b));
  ok('a GitHub Actions workflow runs npm run lint', !!linter,
     'a lint config nothing executes does not prevent anything');
  ok('the lint workflow runs before merge, on pull_request',
     !!linter && /^\s*pull_request:/m.test(linter),
     'linting after merge to main defeats the point');
}


// ---------------------------------------------------------------------------
// CHECK 17 - no SQL suite may go inert (N-17). tests/sql/run.js skips any suite
// without a `-- @requires:` marker, which is correct behaviour: running one
// would load only harness.sql, leaving every check querying empty tables and
// "passing" vacuously. The failure mode is that the skip is easy to stop
// noticing. Four of the eight suites sat skipped long enough to be documented as
// normal, and they were the drop-in-game authorisation tests.
//
// So: every suite must declare its sections, name a section that exists, and
// emit the per-suite counter line the runner's output is read for. A new
// diagnostic script therefore cannot be added in the skipped state - it has to
// be written as assertions, which is the point.
// ---------------------------------------------------------------------------
{
  const sqlDir = path.join(ROOT, 'tests', 'sql');
  const runner = read('tests/sql/run.js');
  // Section keys are declared as `name: () => ...` inside the SECTIONS object.
  const sectionsBlock = runner.slice(runner.indexOf('const SECTIONS = {'),
                                     runner.indexOf('function havePsql()'));
  const known = [...sectionsBlock.matchAll(/^\s{2}(\w+):\s*\(\)\s*=>/gm)].map(m => m[1]);
  ok('the SQL runner exposes sliceable schema sections', known.length >= 5,
     `parsed ${known.length} section name(s) - the @requires check below needs them`);

  const suites = fs.existsSync(sqlDir)
    ? fs.readdirSync(sqlDir).filter(f => f.endsWith('.test.sql')).sort()
    : [];
  ok('SQL suites are present', suites.length > 0, 'no tests/sql/*.test.sql found');

  for (const f of suites) {
    const body = fs.readFileSync(path.join(sqlDir, f), 'utf8');
    const marker = body.match(/--\s*@requires:\s*(.+)/);
    ok(`${f} declares @requires`, !!marker,
       'without it the runner skips this suite and it verifies nothing');
    if (marker) {
      const req = marker[1].split(',').map(s => s.trim()).filter(Boolean);
      const unknown = req.filter(r => !known.includes(r));
      ok(`${f} requires only sections that exist`, unknown.length === 0,
         `unknown section(s): ${unknown.join(', ')}`);
    }
    // The runner decides pass/fail by scanning output for FAIL, so a suite that
    // prints nothing would be indistinguishable from one that passed.
    ok(`${f} reports a per-suite pass/fail count`,
       /count\(\*\) filter \(where ok\)/.test(body) && body.includes('failed   ['),
       'the runner reads these counts; a silent suite looks like a passing one');
  }
}

// ---------------------------------------------------------------------------
// CHECK 18 - console output goes through src/lib/log.ts (F-29). The auth and
// sync paths logged directly in about eighteen places. Nothing logged today is
// sensitive, which is exactly why it needed a gate: the risk is a future edit
// adding a token or an email to a release-build log with nothing to notice it.
//
// This check is what makes the chokepoint real rather than a convention.
// ---------------------------------------------------------------------------
{
  // The modules that touch credentials, sessions and server responses.
  for (const f of ['src/store/AdminProvider.tsx', 'src/sync/sync.ts', 'src/store/StoreProvider.tsx']) {
    const src = read(f);
    const bare = src.match(/\bconsole\.\w+\(/g) || [];
    ok(`${f} has no bare console call`, bare.length === 0,
       `found ${bare.length} (${[...new Set(bare)].join(', ')}) - route through src/lib/log.ts`);
  }

  const log = read('src/lib/log.ts');
  ok('log.ts gates its dev helpers on __DEV__', /__DEV__/.test(log),
     'devLog/devWarn must not reach release builds');
  // A missing global must read as production, not as development - otherwise a
  // bundler that does not inject __DEV__ would silently enable dev logging.
  ok('log.ts treats an absent __DEV__ as production',
     /typeof __DEV__ !== 'undefined'/.test(log),
     'a bare `if (__DEV__)` throws where the global is not injected');
  ok('log.ts still has an always-on warn for real failures',
     /export function warn\(/.test(log),
     'CLAUDE.md forbids swallowing errors; release diagnostics must survive');
}

// ---------------------------------------------------------------------------
// CHECK 22 — every referenced doc path resolves to a file that exists.
//
// The four guides moved from the repo root into docs/, and roughly thirty
// places referred to them: prose in other docs, `read('DEPLOYMENT.md')` in this
// very file, a comment in the CI workflow. A move that misses one leaves a
// reference pointing at nothing, and a wrong path in a doc is worse than no
// path - it reads as authoritative. Nothing would have caught it, so:
// ---------------------------------------------------------------------------
{
  // Files worth scanning. Docs and the things that read them; not source, where
  // a "*.md" string is far more likely to be an example than a link.
  const docish = [
    'README.md', 'CLAUDE.md',
    'docs/README.md', 'docs/AUTH_SETUP.md', 'docs/CODE_REVIEW.md',
    'docs/DEPLOYMENT.md', 'docs/TROUBLESHOOTING.md',
    'tests/README.md', 'tests/MANUAL-REGRESSION.md',
    'tests/static.test.js', 'tests/reducer.test.js', 'tests/sync.test.js',
    '.github/workflows/ci.yml', 'site/README.md',
    // The PR-review agent sends a reviewer to specific docs by path. A doc that
    // moves without it would send them somewhere that no longer exists, which
    // is the exact failure this check was written for.
    '.claude/agents/pr-reviewer.md', '.claude/commands/review-pr.md',
  ];
  // A repo-relative path ending in .md, as a markdown link, in backticks, or
  // bare in prose. Deliberately not matching bare filenames with no directory
  // when they sit next to the file doing the referencing - those are resolved
  // relative to that file below.
  const mdRef = /(?:\]\(|`|\s|^)((?:[\w.-]+\/)*[A-Z][\w.-]*\.md)(?=[`)\s,.:;]|$)/gm;

  const seen = new Set();
  for (const f of docish) {
    if (!exists(f)) continue;
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    // Fenced blocks are illustrations - the architecture tree in README.md draws
    // file names indented under their directory, which is right as a diagram and
    // meaningless as a path. Inline backticks still count: those are references.
    const body = f.endsWith('.md') ? read(f).replace(/^```[\s\S]*?^```/gm, '') : read(f);
    for (const m of body.matchAll(mdRef)) {
      const ref = m[1];
      // Resolve as repo-relative first, then relative to the referring file.
      const asRepo = ref;
      const asLocal = dir ? `${dir}/${ref}` : ref;
      const found = exists(asRepo) || exists(asLocal);
      const key = `${f}|${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ok(`${f} references a real doc: ${ref}`, found,
         'neither ' + asRepo + ' nor ' + asLocal + ' exists');
    }
  }

  // The four guides must be in docs/, not back at the root. A file re-created at
  // the old path would leave two copies and no signal about which is current.
  for (const name of ['AUTH_SETUP', 'CODE_REVIEW', 'DEPLOYMENT', 'TROUBLESHOOTING']) {
    ok(`${name}.md lives in docs/`, exists(`docs/${name}.md`) && !exists(`${name}.md`),
       'the guides moved to docs/; only README.md and CLAUDE.md belong at the root');
  }
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
