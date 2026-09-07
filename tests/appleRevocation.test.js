// Sign in with Apple: account-deletion revocation.
//
// WHAT THIS SUITE IS FOR
//
// App Review 5.1.1(v) requires an app offering Sign in with Apple AND account
// deletion to revoke the Apple authorization as part of deleting the account.
// Before this suite existed, deletion removed auth.users and signed out
// locally, which tells Apple nothing - the app kept a live authorization on the
// person's Apple ID. Three things now have to hold, and all three are the kind
// of thing that reads fine and behaves wrongly:
//
//   1. the ES256 client secret Apple demands is actually well formed and
//      actually signed by the configured key
//   2. the REFRESH token is what gets revoked (revoking only the access token
//      leaves the grant in place, and looks identical from the outside)
//   3. revocation happens BEFORE deletion, and a failed revocation deletes
//      nothing - because once auth.users is gone the app can never prove
//      anything to Apple again
//
// WHAT IT CANNOT COVER
//
// The real appleid.apple.com. Every Apple response here is a fake, so this
// suite proves the requests are right and the branches behave; it is not
// evidence that Apple accepted anything. The end-to-end check is R57 in
// tests/MANUAL-REGRESSION.md, on a real device with a real Apple ID, and its
// verdict is whether iTala disappears from Settings -> Sign in with Apple.
//
// Modules are loaded with `new Function` rather than `vm.runInNewContext`
// (which the neighbouring suites use) on purpose: WebCrypto and the fetch
// classes are involved, and staying in one realm keeps a Uint8Array made here
// acceptable to crypto.subtle over there.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const HookRuntime = require('./harness/pkg/react-live');

const ROOT = path.join(__dirname, '..');

function load(file, imports = {}) {
  const source = ts.transpileModule(fs.readFileSync(path.join(ROOT, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
    fileName: file,
  }).outputText;
  const mod = { exports: {} };
  const req = name => {
    if (!(name in imports)) throw new Error(`Missing mock for '${name}' required by ${file}`);
    return imports[name];
  };
  new Function('exports', 'require', 'module', source)(mod.exports, req, mod);
  return mod.exports;
};

// ---------------------------------------------------------------------------
// Modules under test
// ---------------------------------------------------------------------------
const APPLE_MODULE = 'supabase/functions/_shared/appleAuthorization.ts';
const HANDLER_MODULE = 'supabase/functions/_shared/deleteAccountHandler.ts';
const apple = load(APPLE_MODULE);
const handler = load(HANDLER_MODULE, { './appleAuthorization.ts': apple });
const authErrors = load('src/store/authErrors.ts');

const TOKEN_URL = 'https://appleid.apple.com/auth/token';
const REVOKE_URL = 'https://appleid.apple.com/auth/revoke';
const SUPABASE_URL = 'https://project.supabase.invalid';
const CALLER_TOKEN = 'Bearer caller-access-token';

// Fake Apple credentials. `APPLE_REFRESH`/`APPLE_ACCESS` are also used as
// canaries: no error message, no response body and no log line may contain them.
const APPLE_REFRESH = 'canary-refresh-token';
const APPLE_ACCESS = 'canary-access-token';
const AUTH_CODE = 'canary-authorization-code';

// The Apple `sub` the account is linked to, and a different one for the
// device-changed-hands case. These are what bind a revocation to an account.
const APPLE_SUB = '000123.abcdef0123456789.1200';
const OTHER_APPLE_SUB = '000999.fedcba9876543210.0800';

/** An unsigned stand-in for Apple's id_token: only its claims are read. */
function idToken(claims) {
  const part = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${part({ alg: 'RS256', kid: 'test' })}.${part(claims)}.c2lnbmF0dXJl`;
}
function appleTokens(overrides = {}) {
  return {
    access_token: APPLE_ACCESS,
    refresh_token: APPLE_REFRESH,
    id_token: idToken({ sub: APPLE_SUB, aud: 'com.bpbl.itala', iss: 'https://appleid.apple.com' }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A real P-256 key, so the client secret's signature is verified rather than
// merely parsed. Generated per run; nothing is committed.
// ---------------------------------------------------------------------------
let testKey;
async function keyPair() {
  if (testKey) return testKey;
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  testKey = {
    publicKey: pair.publicKey,
    pem: `-----BEGIN PRIVATE KEY-----\n${der.replace(/(.{64})/g, '$1\n').trim()}\n-----END PRIVATE KEY-----\n`,
  };
  return testKey;
}

async function appleConfig(overrides = {}) {
  const { pem } = await keyPair();
  return {
    teamId: 'TEAMID1234',
    clientId: 'com.bpbl.itala',
    keyId: 'KEYID56789',
    privateKeyPem: pem,
    ...overrides,
  };
}

function decodeJwtPart(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// ---------------------------------------------------------------------------
// Fake Apple. Records every request so the bodies can be asserted, because
// "it called revoke" is not the same claim as "it revoked the right token".
// ---------------------------------------------------------------------------
function fakeApple(options = {}) {
  const requests = [];
  return {
    requests,
    async fetch(url, init = {}) {
      const target = String(url);
      const body = Object.fromEntries(new URLSearchParams(init.body ?? ''));
      requests.push({ url: target, method: init.method, headers: init.headers ?? {}, body });
      if (target === TOKEN_URL) {
        if (options.tokenThrows) throw new Error(options.tokenThrows);
        if (options.tokenStatus) return json({ error: options.tokenError ?? 'invalid_grant' }, options.tokenStatus);
        if (options.tokenUnreadable) return new Response('<html>nope</html>', { status: 200 });
        return json(options.tokens ?? appleTokens());
      }
      if (target === REVOKE_URL) {
        if (options.revokeThrows) throw new Error(options.revokeThrows);
        if (options.revokeStatus) return json({ error: options.revokeError ?? 'invalid_client' }, options.revokeStatus);
        return new Response('', { status: 200 }); // what Apple actually answers
      }
      throw new Error(`fakeApple asked for an unexpected URL: ${target}`);
    },
  };
}

// Full fake environment for the handler: GoTrue, Apple and PostgREST on one
// recorded transport, so ORDERING between them is assertable.
function fakeBackend(options = {}) {
  const applePart = fakeApple(options);
  const requests = [];
  const env = {
    SUPABASE_URL: SUPABASE_URL,
    SUPABASE_ANON_KEY: 'anon-key',
    APPLE_TEAM_ID: 'TEAMID1234',
    APPLE_CLIENT_ID: 'com.bpbl.itala',
    APPLE_KEY_ID: 'KEYID56789',
    // Filled in by prepare() before any case runs, so the handler signs with
    // the same generated key the assertions verify against.
    APPLE_PRIVATE_KEY: testKey?.pem,
    ...options.env,
  };
  const user = options.user === null ? null : {
    id: 'user-1',
    is_anonymous: false,
    identities: [{ provider: 'apple', id: APPLE_SUB, identity_data: { sub: APPLE_SUB } }],
    app_metadata: { provider: 'apple', providers: ['apple'] },
    ...options.user,
  };
  return {
    requests,
    appleRequests: applePart.requests,
    envGet: name => env[name],
    async fetch(url, init = {}) {
      const target = String(url);
      requests.push({ url: target, method: init.method ?? 'GET', headers: init.headers ?? {} });
      if (target === `${SUPABASE_URL}/auth/v1/user`) {
        if (options.userThrows) throw new Error(options.userThrows);
        if (options.userStatus) return json({ message: 'bad jwt' }, options.userStatus);
        if (options.userUnreadable) return new Response('not json', { status: 200 });
        return json(user ?? {});
      }
      if (target === `${SUPABASE_URL}/rest/v1/rpc/delete_own_account`) {
        if (options.deleteThrows) throw new Error(options.deleteThrows);
        if (options.deleteStatus) return json({ message: 'refused' }, options.deleteStatus);
        // 204 is what PostgREST answers a void RPC with. It must be constructed
        // with a null body - `new Response('', {status:204})` throws.
        return new Response(null, { status: 204 });
      }
      return applePart.fetch(url, init);
    },
  };
}

async function callHandler(backend, overrides = {}) {
  const request = new Request(`${SUPABASE_URL}/functions/v1/delete-account`, {
    method: overrides.method ?? 'POST',
    headers: {
      ...(overrides.authorization === null ? {} : { Authorization: overrides.authorization ?? CALLER_TOKEN }),
      'Content-Type': 'application/json',
    },
    ...(overrides.method === 'GET' ? {} : { body: overrides.rawBody ?? JSON.stringify(
      overrides.body ?? { appleAuthorizationCode: AUTH_CODE },
    ) }),
  });
  const response = await handler.handleDeleteAccount(request, {
    env: name => backend.envGet(name),
    fetch: (input, init) => backend.fetch(input, init),
    now: () => 1_757_000_000_000,
  });
  let body = null;
  try { body = await response.clone().json(); } catch { body = null; }
  return { status: response.status, body };
}

/** Every string a failure could have leaked a credential through. */
function leakSurface(...values) {
  return JSON.stringify(values);
}

// ---------------------------------------------------------------------------
const cases = [];
function test(name, fn) { cases.push([name, fn]); }

// ===========================================================================
// A. The client secret Apple demands
// ===========================================================================
test('client secret is a well-formed ES256 JWT signed by the configured key', async () => {
  const { publicKey } = await keyPair();
  const config = await appleConfig();
  const now = 1_757_000_000_000;
  const jwt = await apple.createClientSecret(config, { fetch: async () => new Response(''), now: () => now });

  const [rawHeader, rawPayload, rawSignature] = jwt.split('.');
  assert.equal(jwt.split('.').length, 3, 'a JWS has three parts');
  const header = decodeJwtPart(rawHeader);
  const payload = decodeJwtPart(rawPayload);
  assert.deepEqual(header, { alg: 'ES256', kid: config.keyId, typ: 'JWT' },
    'Apple rejects anything but ES256, and needs the kid to find the public key');
  assert.equal(payload.iss, config.teamId, 'iss is the Apple team, not the client');
  assert.equal(payload.sub, config.clientId, 'sub is the client the code was issued to');
  assert.equal(payload.aud, 'https://appleid.apple.com');
  assert.equal(payload.iat, Math.floor(now / 1000));
  assert.equal(payload.exp, Math.floor(now / 1000) + 300);
  assert.ok(payload.exp - payload.iat <= 15_777_000, "Apple's ceiling is six months");
  assert.ok(!/=/.test(jwt), 'JWS base64url carries no padding');

  // The half that a shape check cannot see: WebCrypto ECDSA output is raw r||s,
  // which is what JWS wants. A DER-wrapped signature would still parse as three
  // dot-separated parts and would be rejected by Apple with invalid_client.
  const signature = Buffer.from(rawSignature, 'base64url');
  assert.equal(signature.length, 64, 'ES256 signatures are a raw 64-byte r||s pair');
  assert.equal(
    await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature,
      new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
    ),
    true,
    'the signature must verify against the configured key',
  );
});

test('missing Apple secrets are reported as configuration, naming what is absent', async () => {
  const present = {
    APPLE_TEAM_ID: 'T', APPLE_CLIENT_ID: 'com.bpbl.itala', APPLE_KEY_ID: 'K',
    APPLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
  };
  for (const absent of Object.keys(present)) {
    const env = { ...present, [absent]: absent === 'APPLE_KEY_ID' ? '   ' : undefined };
    const result = apple.readAppleClientConfig(name => env[name]);
    assert.equal(result.ok, false, `${absent} missing must not read as configured`);
    assert.equal(result.reason, 'configuration');
    assert.match(result.detail, new RegExp(absent), 'the operator has to be told which secret');
  }
  assert.equal(apple.readAppleClientConfig(name => present[name]).ok, true);
});

test('a single-line .p8 secret with escaped newlines is accepted; a non-PEM value is not', async () => {
  const { pem } = await keyPair();
  const base = { APPLE_TEAM_ID: 'T', APPLE_CLIENT_ID: 'c', APPLE_KEY_ID: 'K' };
  // Secrets UIs that will not take a multi-line paste produce exactly this.
  const escaped = apple.readAppleClientConfig(name => ({ ...base, APPLE_PRIVATE_KEY: pem.replace(/\n/g, '\\n') })[name]);
  assert.equal(escaped.ok, true);
  assert.equal(escaped.config.privateKeyPem, pem.trim(), 'the newlines have to come back');

  const certificate = apple.readAppleClientConfig(name => ({ ...base, APPLE_PRIVATE_KEY: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----' })[name]);
  assert.equal(certificate.ok, false);
  assert.match(certificate.detail, /PKCS#8/);
});

test('an unusable private key fails as configuration and never reaches Apple', async () => {
  const server = fakeApple();
  const result = await apple.revokeAppleAuthorization({
    authorizationCode: AUTH_CODE,
    expectedAppleSubject: APPLE_SUB,
    config: await appleConfig({ privateKeyPem: '-----BEGIN PRIVATE KEY-----\nbm90LWEta2V5\n-----END PRIVATE KEY-----' }),
    deps: { fetch: server.fetch },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'configuration', 'a broken deployment is not the person being refused by Apple');
  assert.equal(server.requests.length, 0);
});

// ===========================================================================
// B. The revocation itself
// ===========================================================================
test('revocation exchanges the code, then revokes the REFRESH token', async () => {
  const server = fakeApple();
  const config = await appleConfig();
  const result = await apple.revokeAppleAuthorization({
    authorizationCode: AUTH_CODE,
    expectedAppleSubject: APPLE_SUB, config, deps: { fetch: server.fetch },
  });
  assert.deepEqual(result, { ok: true, tokenType: 'refresh_token' });
  assert.deepEqual(server.requests.map(r => r.url), [TOKEN_URL, REVOKE_URL], 'exchange first, then revoke');

  const [exchange, revoke] = server.requests;
  assert.equal(exchange.method, 'POST');
  assert.equal(exchange.headers['Content-Type'], 'application/x-www-form-urlencoded',
    'Apple only accepts form encoding on these endpoints');
  assert.equal(exchange.body.grant_type, 'authorization_code');
  assert.equal(exchange.body.code, AUTH_CODE);
  assert.equal(exchange.body.client_id, config.clientId);
  assert.equal(exchange.body.client_secret.split('.').length, 3);

  assert.equal(revoke.method, 'POST');
  assert.equal(revoke.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(revoke.body.client_id, config.clientId);
  // THE assertion of this file. Revoking the access token would return 200 and
  // leave the authorization intact, so the app would still be listed on the
  // person's Apple ID and the finding would be unfixed while every test passed.
  assert.equal(revoke.body.token, APPLE_REFRESH, 'the refresh token is what invalidates the whole grant');
  assert.equal(revoke.body.token_type_hint, 'refresh_token');
  assert.notEqual(revoke.body.token, APPLE_ACCESS);
});

test('no refresh token is a refusal, NOT a fallback to the access token', async () => {
  // Apple's revoke endpoint accepts an access token and answers 200, but only
  // revoking the REFRESH token invalidates the authorization. An access-token
  // fallback would therefore report `revoked: true`, let the account be
  // deleted, and leave iTala listed on the person's Apple ID - reintroducing
  // the exact finding, invisibly, on the one branch nobody exercises.
  const server = fakeApple({ tokens: appleTokens({ refresh_token: undefined }) });
  const result = await apple.revokeAppleAuthorization({
    authorizationCode: AUTH_CODE,
    expectedAppleSubject: APPLE_SUB, config: await appleConfig(), deps: { fetch: server.fetch },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'revocation_rejected');
  assert.match(result.detail, /no refresh token/);
  assert.deepEqual(server.requests.map(r => r.url), [TOKEN_URL],
    'with nothing revocable, the revoke endpoint must not be called at all');
});

// ---------------------------------------------------------------------------
// Binding the code to the ACCOUNT. `signInAsync` authenticates whichever Apple
// ID is on the DEVICE, while the Supabase session lives in AsyncStorage and
// survives an iCloud switch, a restored backup or a handed-down phone. Without
// this check, deleting on such a device revokes the CURRENT Apple ID's grant
// (minting one first if it had none), deletes the account, and leaves the
// account's own authorization live.
// ---------------------------------------------------------------------------
test('a code for a different Apple ID revokes nothing and is refused', async () => {
  const server = fakeApple();
  const result = await apple.revokeAppleAuthorization({
    authorizationCode: AUTH_CODE,
    expectedAppleSubject: OTHER_APPLE_SUB, // the account belongs to somebody else
    config: await appleConfig(),
    deps: { fetch: server.fetch },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'subject_mismatch');
  assert.deepEqual(server.requests.map(r => r.url), [TOKEN_URL],
    'the other Apple ID may be a live iTala account on this device; do not revoke it');
});

test('an id_token that is missing, unreadable or for another client is refused', async () => {
  for (const [label, tokens, reason] of [
    ['no id_token', appleTokens({ id_token: undefined }), 'unreachable'],
    ['id_token is not a JWT', appleTokens({ id_token: 'not-a-jwt' }), 'unreachable'],
    ['id_token payload is not JSON', appleTokens({ id_token: 'aaa.bbb.ccc' }), 'unreachable'],
    ['id_token carries no sub', appleTokens({ id_token: idToken({ aud: 'com.bpbl.itala' }) }), 'unreachable'],
    ['id_token is for another client',
      appleTokens({ id_token: idToken({ sub: APPLE_SUB, aud: 'com.someone.else' }) }), 'subject_mismatch'],
  ]) {
    const server = fakeApple({ tokens });
    const result = await apple.revokeAppleAuthorization({
      authorizationCode: AUTH_CODE, expectedAppleSubject: APPLE_SUB,
      config: await appleConfig(), deps: { fetch: server.fetch },
    });
    assert.equal(result.ok, false, label);
    assert.equal(result.reason, reason, label);
    assert.equal(server.requests.length, 1, `${label}: nothing revoked`);
  }
});

test('an account with no known Apple subject is refused before any network call', async () => {
  const server = fakeApple();
  const result = await apple.revokeAppleAuthorization({
    authorizationCode: AUTH_CODE, expectedAppleSubject: '  ',
    config: await appleConfig(), deps: { fetch: server.fetch },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'subject_mismatch');
  assert.equal(server.requests.length, 0,
    'a revocation that cannot be attributed to the account is not evidence of anything');
});

test('a rejected authorization code stops before revoke, and reports Apple\'s slug', async () => {
  const server = fakeApple({ tokenStatus: 400, tokenError: 'invalid_grant' });
  const result = await apple.revokeAppleAuthorization({
    authorizationCode: AUTH_CODE,
    expectedAppleSubject: APPLE_SUB, config: await appleConfig(), deps: { fetch: server.fetch },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'authorization_rejected');
  assert.match(result.detail, /invalid_grant/);
  assert.deepEqual(server.requests.map(r => r.url), [TOKEN_URL], 'nothing to revoke, so do not call revoke');
});

test('a rejected revocation is reported as such, not as success', async () => {
  const server = fakeApple({ revokeStatus: 400, revokeError: 'invalid_client' });
  const result = await apple.revokeAppleAuthorization({
    authorizationCode: AUTH_CODE,
    expectedAppleSubject: APPLE_SUB, config: await appleConfig(), deps: { fetch: server.fetch },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'revocation_rejected');
  assert.match(result.detail, /invalid_client/);
});

test('transport failures and unreadable answers are unreachable, never success', async () => {
  const config = await appleConfig();
  for (const [label, options] of [
    ['token endpoint throws', { tokenThrows: 'Network request failed' }],
    ['revoke endpoint throws', { revokeThrows: 'Network request failed' }],
    ['token endpoint returns non-JSON', { tokenUnreadable: true }],
    ['token endpoint returns no token', { tokens: {} }],
  ]) {
    const server = fakeApple(options);
    const result = await apple.revokeAppleAuthorization({ authorizationCode: AUTH_CODE, expectedAppleSubject: APPLE_SUB, config, deps: { fetch: server.fetch } });
    assert.equal(result.ok, false, label);
    assert.equal(result.reason, 'unreachable', label);
  }
});

test('an empty authorization code is refused without touching the network', async () => {
  const server = fakeApple();
  const result = await apple.revokeAppleAuthorization({
    authorizationCode: '   ',
    expectedAppleSubject: APPLE_SUB, config: await appleConfig(), deps: { fetch: server.fetch },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'authorization_rejected');
  assert.equal(server.requests.length, 0);
});

test('no failure detail ever carries a token or an authorization code', async () => {
  const config = await appleConfig();
  const surfaces = [];
  for (const options of [
    { tokenStatus: 400 }, { revokeStatus: 400 }, { tokenThrows: 'boom' },
    { revokeThrows: 'boom' }, { tokens: {} }, { tokenUnreadable: true },
  ]) {
    const server = fakeApple(options);
    const result = await apple.revokeAppleAuthorization({ authorizationCode: AUTH_CODE, expectedAppleSubject: APPLE_SUB, config, deps: { fetch: server.fetch } });
    surfaces.push(result.detail ?? '');
  }
  const text = leakSurface(surfaces);
  for (const secret of [APPLE_REFRESH, APPLE_ACCESS, AUTH_CODE, config.privateKeyPem]) {
    assert.ok(!text.includes(secret), 'a credential must not travel back inside an error');
  }
});

// ===========================================================================
// C. The Edge Function handler: ordering, fail-closed, least privilege
// ===========================================================================
test('the happy path revokes at Apple and only then deletes the account', async () => {
  const backend = fakeBackend();
  const { status, body } = await callHandler(backend);
  assert.equal(status, 200);
  assert.deepEqual(body, { revoked: true, deleted: true, tokenType: 'refresh_token' });
  assert.deepEqual(
    backend.requests.map(r => r.url.replace(SUPABASE_URL, '')),
    ['/auth/v1/user', TOKEN_URL, REVOKE_URL, '/rest/v1/rpc/delete_own_account'],
    'verify, exchange, revoke, delete - in that order and no other',
  );
});

test('a failed revocation deletes NOTHING and invites a retry', async () => {
  for (const [label, options, expectedStatus] of [
    ['Apple refuses the code', { tokenStatus: 400 }, 502],
    ['Apple refuses the revocation', { revokeStatus: 400 }, 502],
    ['Apple is unreachable', { revokeThrows: 'Network request failed' }, 502],
  ]) {
    const backend = fakeBackend(options);
    const { status, body } = await callHandler(backend);
    assert.equal(status, expectedStatus, label);
    assert.equal(body.error, 'revocation_failed', label);
    assert.ok(
      !backend.requests.some(r => r.url.includes('delete_own_account')),
      `${label}: the account must survive a revocation that did not happen`,
    );
  }
});

test('a missing Apple secret refuses deletion as configuration, before calling Apple', async () => {
  const lines = [];
  const real = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  let answer;
  try {
    answer = await callHandler(fakeBackend({ env: { APPLE_KEY_ID: undefined } }));
  } finally {
    console.log = real;
  }
  assert.equal(answer.status, 500);
  assert.equal(answer.body.error, 'configuration');
  // Which secrets are absent is deployment state. It belongs in the function
  // log, not in a response the device will pass to `warn` - which is NOT
  // dev-gated, so it would land in release-build device logs.
  assert.ok(!/APPLE_/.test(JSON.stringify(answer.body)),
    `response named a secret: ${JSON.stringify(answer.body)}`);
  assert.match(lines.join('\n'), /APPLE_KEY_ID/, 'the operator still needs to know which one');
});

test('a missing Apple secret touches neither Apple nor the account', async () => {
  const backend = fakeBackend({ env: { APPLE_KEY_ID: undefined } });
  await callHandler(backend);
  assert.equal(backend.appleRequests.length, 0);
  assert.ok(!backend.requests.some(r => r.url.includes('delete_own_account')),
    'a half-configured deployment must not delete accounts un-revoked');
});

test('the handler binds the revocation to the account\'s own Apple identity', async () => {
  // Happy path: the sub the function sends for checking is the one GoTrue holds
  // for THIS account, not anything the client supplied.
  const backend = fakeBackend();
  assert.equal((await callHandler(backend)).status, 200);

  // Device now signed in to a different Apple ID than the account was made with.
  const mismatched = fakeBackend({
    tokens: appleTokens({ id_token: idToken({ sub: OTHER_APPLE_SUB, aud: 'com.bpbl.itala' }) }),
  });
  const answer = await callHandler(mismatched);
  assert.equal(answer.status, 409);
  assert.equal(answer.body.error, 'apple_account_mismatch',
    'a mismatch is permanent until the device changes, so it must not be worded as a retry');
  assert.deepEqual(mismatched.appleRequests.map(r => r.url), [TOKEN_URL],
    'the other Apple ID keeps its authorization');
  assert.ok(!mismatched.requests.some(r => r.url.includes('delete_own_account')),
    'and this account keeps its own, un-revoked, so it must not be deleted');
});

test('an Apple account whose subject cannot be read is refused, not deleted', async () => {
  // `app_metadata` says apple but no identity row carries a subject, so there
  // is nothing to bind the revocation to. Refusing is the only safe answer.
  const backend = fakeBackend({
    user: { identities: [], app_metadata: { provider: 'apple', providers: ['apple'] } },
  });
  const { status, body } = await callHandler(backend);
  assert.equal(status, 502);
  assert.equal(body.error, 'apple_identity_unreadable');
  assert.equal(backend.appleRequests.length, 0);
  assert.ok(!backend.requests.some(r => r.url.includes('delete_own_account')));
});

test('an unsigned, anonymous or unverifiable caller is refused without side effects', async () => {
  for (const [label, overrides, options, expected] of [
    ['GET', { method: 'GET' }, {}, { status: 405, error: 'method_not_allowed' }],
    ['no Authorization header', { authorization: null }, {}, { status: 401, error: 'missing_authorization' }],
    ['empty bearer', { authorization: 'Bearer ' }, {}, { status: 401, error: 'missing_authorization' }],
    ['rejected token', {}, { userStatus: 401 }, { status: 401, error: 'invalid_session' }],
    ['GoTrue unreachable', {}, { userThrows: 'Network request failed' }, { status: 502, error: 'invalid_session' }],
    ['unreadable user payload', {}, { userUnreadable: true }, { status: 502, error: 'invalid_session' }],
    ['guest session', {}, { user: { is_anonymous: true } }, { status: 403, error: 'anonymous_session' }],
    ['malformed body', { rawBody: 'not json' }, {}, { status: 400, error: 'malformed_request' }],
  ]) {
    const backend = fakeBackend(options);
    const { status, body } = await callHandler(backend, overrides);
    assert.equal(status, expected.status, label);
    assert.equal(body.error, expected.error, label);
    assert.equal(backend.appleRequests.length, 0, `${label}: no Apple call`);
    assert.ok(!backend.requests.some(r => r.url.includes('delete_own_account')), `${label}: no deletion`);
  }
});

test('a Google-only account is handed back to the RPC path rather than deleted here', async () => {
  const backend = fakeBackend({
    user: { identities: [{ provider: 'google' }], app_metadata: { provider: 'google', providers: ['google'] } },
  });
  const { status, body } = await callHandler(backend);
  assert.equal(status, 409);
  assert.equal(body.error, 'no_apple_identity');
  assert.equal(backend.appleRequests.length, 0);
  assert.ok(!backend.requests.some(r => r.url.includes('delete_own_account')),
    'this function only owns the Apple path; the RPC still owns the other one');
});

test('an Apple identity is recognised however GoTrue spells it', async () => {
  // Whichever field carries it, an identity with a subject can be bound and
  // therefore revoked.
  for (const user of [
    { identities: [{ provider: 'apple', id: APPLE_SUB }], app_metadata: null },
    { identities: [{ provider: 'apple', identity_data: { sub: APPLE_SUB } }], app_metadata: null },
    { identities: [null, { provider: 'google', id: 'g' }, { provider: 'apple', id: APPLE_SUB }] },
  ]) {
    const backend = fakeBackend({ user });
    assert.equal((await callHandler(backend)).status, 200, `apple identity missed for ${JSON.stringify(user)}`);
  }
});

test('an Apple account whose identities are not expanded is refused, never handed to the RPC', async () => {
  // THE dangerous shape. If `identities` arrives empty or absent while
  // app_metadata still says apple, the account IS Apple-linked but no subject
  // is available to bind a revocation to.
  //
  // The wrong answer here is `no_apple_identity`, because the client treats
  // that as "nothing to revoke" and deletes through the plain RPC - an
  // un-revoked deletion, which is the original finding. So the app_metadata
  // fallback is load-bearing for SAFETY even though it can never authorise a
  // revocation on its own.
  for (const user of [
    { identities: undefined, app_metadata: { provider: 'apple', providers: ['apple'] } },
    { identities: [], app_metadata: { provider: 'email', providers: ['email', 'apple'] } },
    { identities: [{ provider: 'apple' }], app_metadata: null }, // present, but no subject
  ]) {
    const backend = fakeBackend({ user });
    const { status, body } = await callHandler(backend);
    assert.equal(body.error, 'apple_identity_unreadable', JSON.stringify(user));
    assert.notEqual(body.error, 'no_apple_identity');
    assert.equal(status, 502);
    assert.equal(backend.appleRequests.length, 0);
    assert.ok(!backend.requests.some(r => r.url.includes('delete_own_account')),
      'an Apple account must never be deleted through a path that revoked nothing');
  }
});

test('a missing authorization code is refused before Apple is contacted', async () => {
  for (const body of [{}, { appleAuthorizationCode: '' }, { appleAuthorizationCode: '  ' }, { appleAuthorizationCode: 42 }]) {
    const backend = fakeBackend();
    const answer = await callHandler(backend, { body });
    assert.equal(answer.status, 400);
    assert.equal(answer.body.error, 'missing_authorization_code');
    assert.equal(backend.appleRequests.length, 0);
  }
});

test('deletion failing after a successful revocation is reported honestly', async () => {
  for (const options of [{ deleteStatus: 403 }, { deleteThrows: 'Network request failed' }]) {
    const backend = fakeBackend(options);
    const { status, body } = await callHandler(backend);
    assert.equal(status, 502);
    assert.equal(body.error, 'deletion_failed');
    assert.match(body.detail, /revoked/, 'the person has to know the Apple half already happened');
    assert.deepEqual(backend.appleRequests.map(r => r.url), [TOKEN_URL, REVOKE_URL]);
  }
});

test('the deletion is authorised by the caller\'s own token, with no service-role key anywhere', async () => {
  const backend = fakeBackend();
  await callHandler(backend);
  const deletion = backend.requests.find(r => r.url.includes('delete_own_account'));
  assert.equal(deletion.headers.Authorization, CALLER_TOKEN,
    'delete_own_account must run as the caller so auth.uid() still authorises it');
  assert.equal(deletion.headers.apikey, 'anon-key');
  const everyHeader = leakSurface(backend.requests.map(r => r.headers));
  assert.ok(!/service_role|SERVICE_ROLE/.test(everyHeader),
    'the function has no service-role privilege and must not acquire one');
  const lookup = backend.requests[0];
  assert.equal(lookup.url, `${SUPABASE_URL}/auth/v1/user`);
  assert.equal(lookup.headers.Authorization, CALLER_TOKEN,
    'the token is verified by GoTrue, not decoded locally');
});

test('function logs carry no user id, no token and no authorization code', async () => {
  const lines = [];
  const real = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    await callHandler(fakeBackend());
    await callHandler(fakeBackend({ revokeStatus: 400 }));
    await callHandler(fakeBackend({ user: { is_anonymous: true } }));
    await callHandler(fakeBackend({ deleteStatus: 403 }));
  } finally {
    console.log = real;
  }
  assert.ok(lines.length >= 4, 'each request should leave one auditable line');
  const text = lines.join('\n');
  for (const secret of [APPLE_REFRESH, APPLE_ACCESS, AUTH_CODE, 'user-1', 'caller-access-token']) {
    assert.ok(!text.includes(secret), `logs leaked ${secret}`);
  }
  assert.match(text, /revoked_and_deleted/, 'a successful revocation is still auditable');
});

// ===========================================================================
// D. The device half
// ===========================================================================
function loadClient(appleModule, platform = 'ios') {
  return load('src/lib/appleAccountDeletion.ts', {
    'react-native': { Platform: { OS: platform } },
    'expo-apple-authentication': appleModule,
    '../store/authErrors': authErrors,
  });
}
const clientDefault = loadClient({ signInAsync: async () => ({ authorizationCode: AUTH_CODE }) });

test('hasAppleIdentity reads every shape GoTrue produces, and nothing else', () => {
  const yes = [
    { identities: [{ provider: 'apple' }] },
    { identities: [{ provider: 'google' }, { provider: 'apple' }] },
    { app_metadata: { provider: 'apple' } },
    { app_metadata: { providers: ['email', 'apple'] } },
  ];
  const no = [
    null, undefined, {}, { identities: [] }, { identities: [null] },
    { identities: [{ provider: 'google' }], app_metadata: { provider: 'google', providers: ['google'] } },
    { app_metadata: { provider: 'apple-ish' } },
  ];
  for (const user of yes) assert.equal(clientDefault.hasAppleIdentity(user), true, JSON.stringify(user));
  for (const user of no) assert.equal(clientDefault.hasAppleIdentity(user), false, JSON.stringify(user));
});

test('closing the Apple sheet is an answer, not an error', async () => {
  const client = loadClient({
    signInAsync: async () => { throw Object.assign(new Error('cancelled'), { code: 'ERR_REQUEST_CANCELED' }); },
  });
  assert.deepEqual(await client.requestAppleAuthorizationCode(), { status: 'cancelled' });

  let invoked = 0;
  const outcome = await client.deleteAppleAccount({
    requestAuthorizationCode: client.requestAppleAuthorizationCode,
    invoke: async () => { invoked++; return { data: null, error: null }; },
  });
  assert.deepEqual(outcome, { status: 'cancelled' });
  assert.equal(invoked, 0, 'a cancelled confirmation must not reach the server');
});

test('a sheet that returns no authorization code fails without calling the server', async () => {
  const client = loadClient({ signInAsync: async () => ({ authorizationCode: null }) });
  let invoked = 0;
  const outcome = await client.deleteAppleAccount({
    requestAuthorizationCode: client.requestAppleAuthorizationCode,
    invoke: async () => { invoked++; return { data: null, error: null }; },
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(invoked, 0);
  assert.match(outcome.diagnosis, /no authorizationCode/);
});

test('an Apple sheet failure is described without naming Apple internals', async () => {
  const offline = loadClient({ signInAsync: async () => { throw new Error('Network request failed'); } });
  const result = await offline.requestAppleAuthorizationCode();
  assert.equal(result.status, 'failed');
  assert.match(result.message, /internet connection/);
  const broken = loadClient({ signInAsync: async () => { throw Object.assign(new Error('AKAuthenticationError -7026'), { code: 'ERR_APPLE' }); } });
  const other = await broken.requestAppleAuthorizationCode();
  assert.equal(other.status, 'failed');
  assert.match(other.diagnosis, /-7026/, 'the log keeps the detail');
  assert.ok(!/-7026/.test(other.message), 'the person does not');
});

// Both stores require in-app deletion to be AVAILABLE. Routing Apple accounts
// through a native sheet creates states where it cannot complete no matter how
// many times somebody taps, so every one of them has to name a route that does
// work - "Please try again" on a permanent failure is a dead end.
test('a permanent Apple-sheet failure offers a route that is not "try again"', async () => {
  const cases = [
    ['Android', loadClient({ signInAsync: async () => { throw new Error('unavailable'); } }, 'android')],
    ['web', loadClient({ signInAsync: async () => { throw new Error('unavailable'); } }, 'web')],
    ['signed out of iCloud', loadClient({
      signInAsync: async () => { throw Object.assign(new Error('no Apple ID'), { code: 'ERR_REQUEST_UNKNOWN' }); },
    })],
    ['no authorization code returned', loadClient({ signInAsync: async () => ({ authorizationCode: null }) })],
  ];
  for (const [label, client] of cases) {
    const result = await client.requestAppleAuthorizationCode();
    assert.equal(result.status, 'failed', label);
    assert.match(result.message, /@/, `${label}: no contact route offered`);
  }

  // The non-iOS cases must not even reach the native module: `signInAsync`
  // throws UnavailabilityError there, whose message would be reported as
  // "could not confirm on this device. Please try again", which is untrue.
  let reached = 0;
  const android = loadClient({ signInAsync: async () => { reached++; throw new Error('unavailable'); } }, 'android');
  const result = await android.requestAppleAuthorizationCode();
  assert.equal(reached, 0, 'the iOS-only sheet must not be invoked off iOS');
  assert.match(result.message, /iPhone or iPad/);
  assert.match(result.diagnosis, /Platform\.OS=android/);
});

test('an Apple ID mismatch is explained as a mismatch, and offers a way out', async () => {
  const httpError = slug => ({
    message: 'Edge Function returned a non-2xx status code',
    context: { json: async () => ({ error: slug }) },
  });
  const outcome = await clientDefault.deleteAppleAccount({
    requestAuthorizationCode: clientDefault.requestAppleAuthorizationCode,
    invoke: async () => ({ data: null, error: httpError('apple_account_mismatch') }),
  });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.message, /different Apple ID/);
  assert.match(outcome.message, /@/, 'the person may not be able to sign the device in as that Apple ID');
  assert.ok(!/try again\.$/.test(outcome.message), 'retrying on the same device cannot succeed');
});

test('the client sends the fresh code and requires both halves to be confirmed', async () => {
  const bodies = [];
  const invoke = async body => { bodies.push(body); return { data: { revoked: true, deleted: true }, error: null }; };
  assert.deepEqual(
    await clientDefault.deleteAppleAccount({ requestAuthorizationCode: clientDefault.requestAppleAuthorizationCode, invoke }),
    { status: 'deleted' },
  );
  assert.deepEqual(bodies, [{ appleAuthorizationCode: AUTH_CODE }]);

  // A 2xx is not evidence. Signing the person out here would tell them the
  // account was deleted while it and the Apple authorization both still exist.
  for (const data of [null, {}, { revoked: true }, { deleted: true }, { revoked: 'yes', deleted: 'yes' }]) {
    const outcome = await clientDefault.deleteAppleAccount({
      requestAuthorizationCode: clientDefault.requestAppleAuthorizationCode,
      invoke: async () => ({ data, error: null }),
    });
    assert.equal(outcome.status, 'failed', `unconfirmed answer accepted: ${JSON.stringify(data)}`);
  }
});

test('each server slug becomes its own message, read out of the FunctionsHttpError body', async () => {
  const httpError = (slug, detail) => ({
    name: 'FunctionsHttpError',
    message: 'Edge Function returned a non-2xx status code',
    context: { json: async () => ({ error: slug, detail }) },
  });
  const seen = new Map();
  for (const slug of [
    'revocation_failed', 'deletion_failed', 'configuration', 'invalid_session',
    'missing_authorization_code', 'authorization_rejected', 'anonymous_session', 'malformed_request',
  ]) {
    const outcome = await clientDefault.deleteAppleAccount({
      requestAuthorizationCode: clientDefault.requestAppleAuthorizationCode,
      invoke: async () => ({ data: null, error: httpError(slug, 'detail') }),
    });
    assert.equal(outcome.status, 'failed', slug);
    assert.match(outcome.diagnosis, new RegExp(slug), 'the log names the slug');
    assert.ok(!/non-2xx/.test(outcome.message), `${slug} fell back to supabase-js wording`);
    seen.set(slug, outcome.message);
  }
  assert.match(seen.get('revocation_failed'), /nothing was deleted/i);
  assert.match(seen.get('deletion_failed'), /stopped using your Apple ID/i);
  assert.equal(new Set(seen.values()).size >= 6, true, 'distinct causes must not collapse to one message');

  // The server's identity check overrules ours, and the caller falls through to
  // the plain RPC rather than refusing to delete a Google-only account.
  const notApple = await clientDefault.deleteAppleAccount({
    requestAuthorizationCode: clientDefault.requestAppleAuthorizationCode,
    invoke: async () => ({ data: null, error: httpError('no_apple_identity') }),
  });
  assert.deepEqual(notApple, { status: 'not-apple' });
});

test('a timeout or transport failure reads as a connection problem, not a refusal', async () => {
  for (const error of [
    { message: 'timeout' },
    { message: 'Network request failed' },
    { message: 'fetch failed' },
    // supabase-js's own wording for a failed fetch to an Edge Function
    // (FunctionsFetchError). It matches none of the transport's spellings, so it
    // has to be recognised explicitly or an offline phone gets a generic message.
    { name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function' },
  ]) {
    const outcome = await clientDefault.deleteAppleAccount({
      requestAuthorizationCode: clientDefault.requestAppleAuthorizationCode,
      invoke: async () => ({ data: null, error }),
    });
    // NOT 'failed'. The function revokes and deletes in one request, so a
    // request that never answered may have completed - the caller has to find
    // out before it tells anybody the deletion failed.
    assert.equal(outcome.status, 'unconfirmed', JSON.stringify(error));
    assert.match(outcome.message, /internet connection|Couldn't reach/);
  }
  const thrown = await clientDefault.deleteAppleAccount({
    requestAuthorizationCode: clientDefault.requestAppleAuthorizationCode,
    invoke: async () => { throw new Error('Network request failed'); },
  });
  assert.equal(thrown.status, 'unconfirmed');
  assert.match(thrown.message, /internet connection/);
});

// ---------------------------------------------------------------------------
// accountNoLongerExists: the predicate the unconfirmed case turns on. Getting
// it wrong is bad in both directions, so both directions are pinned.
// ---------------------------------------------------------------------------
test('only an explicit "no such user" counts as a deleted account', () => {
  const gone = [
    { data: { user: null }, error: { code: 'user_not_found', message: 'User from sub claim in JWT does not exist' } },
    { data: { user: null }, error: { status: 403, message: 'User from sub claim in JWT does not exist' } },
    { data: { user: null }, error: null },
  ];
  const unknown = [
    null, undefined,
    { data: { user: { id: 'a' } }, error: null },
    // A non-answer proves nothing: reading it as success would sign somebody
    // out of an account that still exists.
    { data: { user: null }, error: { message: 'timeout' } },
    { data: { user: null }, error: { message: 'Network request failed' } },
    { data: { user: null }, error: { message: 'fetch failed' } },
    // A bare 401 is an expired or remotely revoked session, not a deletion.
    { data: { user: null }, error: { status: 401, message: 'invalid claim: missing sub claim' } },
    { data: { user: null }, error: { message: 'Invalid Refresh Token' } },
  ];
  for (const outcome of gone) {
    assert.equal(authErrors.accountNoLongerExists(outcome), true, JSON.stringify(outcome));
  }
  for (const outcome of unknown) {
    assert.equal(authErrors.accountNoLongerExists(outcome), false, JSON.stringify(outcome));
  }
});

// ===========================================================================
// E. AdminProvider: which path a real deletion takes
// ===========================================================================
function providerHarness(options = {}) {
  const calls = [];
  const disk = new Map();
  const legal = load('src/lib/legal.ts', {
    '@react-native-async-storage/async-storage': {
      default: {
        getItem: async k => disk.get(k) ?? null,
        setItem: async (k, v) => { disk.set(k, v); },
        removeItem: async k => { disk.delete(k); },
      },
    },
  });
  const receipt = { version: legal.LEGAL_VERSION, accepted_at: '2026-09-07T01:02:03.000Z' };
  const account = {
    id: 'account-a', email: 'a@example.invalid', is_anonymous: false,
    identities: options.identities ?? [{ provider: 'apple' }],
    app_metadata: options.appMetadata ?? { provider: 'apple', providers: ['apple'] },
  };
  const guest = { id: 'guest', is_anonymous: true };
  let session = { user: account };
  disk.set(`itala.legal.receipt.v1.${account.id}`, JSON.stringify(receipt));

  const RN = {
    Platform: { OS: 'ios' }, StyleSheet: { create: v => v },
    Linking: { openURL: async () => {} },
    Modal: 'Modal', ScrollView: 'ScrollView', Text: 'Text', TouchableOpacity: 'TouchableOpacity', View: 'View',
  };
  const component = load('src/components/LegalAcknowledgement.tsx', {
    react: HookRuntime, 'react-native': RN,
    '../theme': { colors: {}, font: {}, radius: {}, space: n => n }, '../lib/legal': legal,
  });
  const sb = {
    rpc: async (name, args) => {
      calls.push([name, args]);
      if (name === 'legal_status') return { data: receipt, error: null };
      if (name === 'delete_own_account') return options.rpcError ? { data: null, error: options.rpcError } : { data: null, error: null };
      return { data: [], error: null };
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { is_admin: false } }) }) }) }),
    functions: {
      invoke: async (name, payload) => {
        calls.push(['invoke', name, payload]);
        return options.functionAnswer ?? { data: { revoked: true, deleted: true, tokenType: 'refresh_token' }, error: null };
      },
    },
    auth: {
      getSession: async () => ({ data: { session } }),
      getUser: async () => {
        calls.push(['getUser']);
        // `getUserOutcomes` answers successive calls, so the first (which picks
        // the deletion path) and the re-check after an unanswered request can
        // differ - which is the whole point of the re-check.
        if (options.getUserOutcomes?.length) return options.getUserOutcomes.shift();
        if (options.getUserError) return { data: { user: null }, error: options.getUserError };
        return { data: { user: session?.user ?? null }, error: null };
      },
      signOut: async scope => { calls.push(['signOut', scope]); session = null; return { error: null }; },
      signInAnonymously: async () => { session = { user: guest }; return { data: { session, user: guest }, error: null }; },
    },
  };
  const appleClient = loadClient({
    signInAsync: async args => {
      calls.push(['appleSheet', args]);
      if (options.cancelSheet) throw Object.assign(new Error('cancelled'), { code: 'ERR_REQUEST_CANCELED' });
      return { authorizationCode: options.noCode ? null : AUTH_CODE };
    },
  }, options.platform ?? 'ios');
  const provider = load('src/store/AdminProvider.tsx', {
    react: HookRuntime, 'react-native': RN,
    'expo-web-browser': { maybeCompleteAuthSession() {}, openAuthSessionAsync: async () => ({ type: 'cancel' }) },
    'expo-linking': { createURL: () => 'itala://auth-callback', parse: () => ({ queryParams: {} }) },
    'expo-apple-authentication': { isAvailableAsync: async () => true, AppleAuthenticationScope: {}, signInAsync: async () => ({}) },
    '../sync/supabase': { SYNC_ENABLED: true, getSupabase: () => sb },
    './guestSession': load('src/store/guestSession.ts', {}),
    '../lib/appleAccountDeletion': appleClient,
    '../lib/log': { devLog() {}, warn() {} },
    '../components/LegalAcknowledgement': component, '../lib/legal': legal,
    './authErrors': authErrors,
  });
  const root = HookRuntime.render(provider.AdminProvider, { children: null });
  return {
    root, calls, disk,
    get ctx() { return root.element.props.value; },
    async settle() { for (let i = 0; i < 35; i++) { await new Promise(r => setImmediate(r)); root.flush(); } },
    count(name) { return calls.filter(c => c[0] === name).length; },
  };
}

test('an Apple account is deleted through the revoking function, never the bare RPC', async () => {
  const p = providerHarness(); await p.settle();
  assert.equal(p.ctx.role, 'user', 'the harness has to reach a signed-in account first');
  assert.equal(await p.ctx.deleteAccount(), true);
  await p.settle();
  assert.equal(p.count('appleSheet'), 1, 'a fresh authorization code is required');
  const invocation = p.calls.find(c => c[0] === 'invoke');
  assert.deepEqual([invocation[1], invocation[2]], ['delete-account', { body: { appleAuthorizationCode: AUTH_CODE } }]);
  assert.equal(p.count('delete_own_account'), 0,
    'the RPC alone would delete the account and leave the Apple authorization live');
  assert.equal(p.ctx.user, null);
  assert.equal(p.ctx.userId, 'guest', 'the device returns to guest browsing');
  assert.equal(p.disk.size, 0, 'the deleted account keeps no legal receipt cache');
  p.root.unmount();
});

test('a refused revocation leaves the account alone and says so', async () => {
  const p = providerHarness({
    functionAnswer: {
      data: null,
      error: { message: 'Edge Function returned a non-2xx status code', context: { json: async () => ({ error: 'revocation_failed', detail: 'unreachable' }) } },
    },
  });
  await p.settle();
  assert.equal(await p.ctx.deleteAccount(), false);
  await p.settle();
  assert.equal(p.count('delete_own_account'), 0, 'no revocation, no deletion');
  assert.match(p.ctx.errorFor('account'), /nothing was deleted/i);
  assert.equal(p.ctx.role, 'user', 'the account is still usable');
  assert.equal(p.ctx.authBusy, false);
  p.root.unmount();
});

test('cancelling the Apple confirmation deletes nothing and blames nobody', async () => {
  const p = providerHarness({ cancelSheet: true }); await p.settle();
  assert.equal(await p.ctx.deleteAccount(), false);
  await p.settle();
  assert.equal(p.count('invoke'), 0);
  assert.equal(p.count('delete_own_account'), 0);
  assert.equal(p.ctx.errorFor('account'), null, 'closing a sheet is not a failure to report');
  assert.equal(p.ctx.role, 'user');
  p.root.unmount();
});

test('a Google-only account still deletes through the RPC, unchanged', async () => {
  const p = providerHarness({
    identities: [{ provider: 'google' }], appMetadata: { provider: 'google', providers: ['google'] },
  });
  await p.settle();
  assert.equal(await p.ctx.deleteAccount(), true);
  await p.settle();
  assert.equal(p.count('appleSheet'), 0, 'no Apple sheet for an account with no Apple identity');
  assert.equal(p.count('invoke'), 0);
  assert.equal(p.count('delete_own_account'), 1);
  assert.equal(p.ctx.userId, 'guest');
  p.root.unmount();
});

test('an account whose providers cannot be read is not deleted at all', async () => {
  // The dangerous shape: if an unreadable identity fell through to the RPC, an
  // Apple account would be deleted un-revoked exactly when the network is bad.
  const p = providerHarness({ getUserError: { message: 'network request failed' } });
  await p.settle();
  assert.equal(await p.ctx.deleteAccount(), false);
  await p.settle();
  assert.equal(p.count('delete_own_account'), 0);
  assert.equal(p.count('invoke'), 0);
  assert.match(p.ctx.errorFor('account'), /internet connection/);
  p.root.unmount();
});

test('the server overruling the client falls back to the RPC instead of refusing', async () => {
  const p = providerHarness({
    functionAnswer: {
      data: null,
      error: { message: 'non-2xx', context: { json: async () => ({ error: 'no_apple_identity' }) } },
    },
  });
  await p.settle();
  assert.equal(await p.ctx.deleteAccount(), true);
  await p.settle();
  assert.equal(p.count('delete_own_account'), 1);
  assert.equal(p.ctx.userId, 'guest');
  p.root.unmount();
});

// ---------------------------------------------------------------------------
// The unanswered request. One call does both halves, so a timeout sits on
// either side of a completed deletion and the app must find out which.
// ---------------------------------------------------------------------------
const APPLE_IDENTITY = { identities: [{ provider: 'apple', id: APPLE_SUB, identity_data: { sub: APPLE_SUB } }] };
const GONE = { data: { user: null }, error: { code: 'user_not_found', message: 'User from sub claim in JWT does not exist' } };
const SIGNED_IN = { data: { user: { id: 'account-a', email: 'a@example.invalid', is_anonymous: false, ...APPLE_IDENTITY } }, error: null };

test('a timeout after the server finished completes the deletion instead of stranding it', async () => {
  const p = providerHarness({
    functionAnswer: { data: null, error: { message: 'timeout' } },
    // First call chooses the path; the re-check finds the account gone.
    getUserOutcomes: [SIGNED_IN, GONE],
  });
  await p.settle();
  assert.equal(await p.ctx.deleteAccount(), true,
    'the deletion DID happen; reporting failure would strand an orphaned session');
  await p.settle();
  assert.equal(p.count('delete_own_account'), 0, 'and it must not be re-attempted through the RPC');
  assert.equal(p.ctx.errorFor('account'), null);
  assert.equal(p.ctx.user, null);
  assert.equal(p.ctx.userId, 'guest');
  assert.equal(p.disk.size, 0);
  p.root.unmount();
});

test('a timeout with the account still there reports a connection problem, not success', async () => {
  const p = providerHarness({
    functionAnswer: { data: null, error: { message: 'timeout' } },
    getUserOutcomes: [SIGNED_IN, SIGNED_IN],
  });
  await p.settle();
  assert.equal(await p.ctx.deleteAccount(), false);
  await p.settle();
  assert.match(p.ctx.errorFor('account'), /internet connection|Couldn't reach/);
  assert.equal(p.ctx.role, 'user', 'the account is untouched and still usable');
  assert.equal(p.count('delete_own_account'), 0);
  p.root.unmount();
});

test('a second non-answer is not read as success', async () => {
  const p = providerHarness({
    functionAnswer: { data: null, error: { message: 'timeout' } },
    getUserOutcomes: [SIGNED_IN, { data: { user: null }, error: { message: 'Network request failed' } }],
  });
  await p.settle();
  assert.equal(await p.ctx.deleteAccount(), false,
    'an unreachable server proves nothing; signing out here would claim a deletion that may not have happened');
  await p.settle();
  assert.ok(p.ctx.errorFor('account'));
  p.root.unmount();
});

test('an account already deleted elsewhere clears the local session without an error', async () => {
  // The account is gone before deletion is even asked for - another device did
  // it, or an earlier attempt succeeded and its answer was lost. There is
  // nothing to revoke and nothing to delete, so refusing would report a failure
  // for work already done and leave the device holding a dead session.
  const p = providerHarness({ getUserOutcomes: [GONE] });
  await p.settle();
  assert.equal(await p.ctx.deleteAccount(), true);
  await p.settle();
  assert.equal(p.count('appleSheet'), 0, 'nothing to revoke for an account that is gone');
  assert.equal(p.count('invoke'), 0);
  assert.equal(p.count('delete_own_account'), 0);
  assert.equal(p.ctx.errorFor('account'), null);
  assert.equal(p.ctx.userId, 'guest');
  p.root.unmount();
});

test('an unreadable account is refused with deletion wording, not sign-in wording', async () => {
  const p = providerHarness({ getUserError: { message: 'unexpected_failure' } });
  await p.settle();
  assert.equal(await p.ctx.deleteAccount(), false);
  await p.settle();
  const message = p.ctx.errorFor('account');
  assert.ok(!/sign.?in/i.test(message),
    `"Could not delete account" must not be explained with sign-in wording: ${message}`);
  assert.match(message, /nothing was deleted/i);
  assert.equal(p.count('delete_own_account'), 0);
  p.root.unmount();
});

test('the signed-in provider is reported accurately, not assumed to be Google', async () => {
  const appleSession = providerHarness(); await appleSession.settle();
  assert.deepEqual(appleSession.ctx.user.providers, ['apple']);
  appleSession.root.unmount();
  const googleSession = providerHarness({
    identities: [{ provider: 'google' }], appMetadata: { provider: 'google', providers: ['google'] },
  });
  await googleSession.settle();
  assert.deepEqual(googleSession.ctx.user.providers, ['google']);
  googleSession.root.unmount();
});

// ---------------------------------------------------------------------------
(async () => {
  // One generated key for the whole run, resolved before any case builds an
  // environment out of it.
  await keyPair();
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`  PASS ${name}`); }
    catch (e) { failed++; console.error(`  FAIL ${name}\n${e.stack}`); }
  }
  console.log(`Apple revocation: ${cases.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
