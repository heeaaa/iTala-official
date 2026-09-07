// Sign in with Apple: server-side authorization revocation.
//
// WHY THIS FILE EXISTS
//
// Deleting `auth.users` and signing out locally removes iTala's record of a
// person. It does NOT tell Apple anything, so the app keeps sitting in
// Settings -> Apple ID -> Sign in with Apple -> Apps using Apple ID, and the
// authorization iTala was granted stays live. App Review guideline 5.1.1(v)
// requires an app that offers Sign in with Apple AND account deletion to call
// Apple's REST revoke endpoint as part of that deletion. That call needs an
// ES256 client secret signed with the team's private key, which cannot exist on
// a device, so it has to happen on a server.
//
// WHY IT IS SPLIT OUT OF THE FUNCTION ENTRY POINT
//
// Everything here is built on Web-standard `fetch` and WebCrypto only - no Deno
// globals, no URL imports, no dependencies. That is deliberate: the same module
// runs under Deno in the deployed Edge Function and under Node in
// `tests/appleRevocation.test.js`, so the JWT claims, the request bodies and
// the failure handling are covered by an automated test rather than by reading
// the code and hoping.
//
// NOTHING HERE MAY LOG OR RETURN A TOKEN. An authorization code, an access
// token and a refresh token are all credentials for somebody's Apple ID; they
// are passed to Apple and then dropped. Failures carry Apple's short `error`
// slug and nothing else.

/** Apple's OAuth host. Both endpoints used below live on it. */
export const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
export const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';

/** The audience Apple requires in the client-secret JWT. */
const APPLE_AUDIENCE = 'https://appleid.apple.com';

/** How long a client secret stays valid. Apple's ceiling is six months; a
 *  request-scoped secret has no reason to outlive the request. */
const CLIENT_SECRET_TTL_SECONDS = 300;

export interface AppleClientConfig {
  /** Apple Developer team id (the client secret's `iss`). */
  teamId: string;
  /**
   * The audience of the authorization code being revoked. For the native
   * `expo-apple-authentication` sheet that is the app's BUNDLE ID, not a
   * Services ID - Apple signs the credential for whichever app asked, so a
   * mismatch here fails the token exchange with `invalid_client`.
   */
  clientId: string;
  /** Key id of the Sign in with Apple private key (the client secret's `kid`). */
  keyId: string;
  /** The .p8 private key, PKCS#8 PEM. */
  privateKeyPem: string;
}

export interface AppleRevocationDeps {
  /** Injected so tests can answer as Apple without a network. */
  fetch: typeof fetch;
  /** Injected so the client secret's `iat`/`exp` are assertable. */
  now?: () => number;
  subtle?: SubtleCrypto;
}

export type AppleRevocationResult =
  | { ok: true; tokenType: 'refresh_token' }
  | { ok: false; reason: AppleRevocationFailure; detail?: string };

export type AppleRevocationFailure =
  /** A secret is missing or malformed - an operator problem, not a user one. */
  | 'configuration'
  /** Apple refused the authorization code (expired, reused, wrong audience). */
  | 'authorization_rejected'
  /**
   * The code belongs to a DIFFERENT Apple ID than the account being deleted.
   * Nothing is revoked and nothing may be deleted - see the note on
   * `expectedAppleSubject` below.
   */
  | 'subject_mismatch'
  /** Apple refused the revocation itself. */
  | 'revocation_rejected'
  /** Apple could not be reached, or answered something unusable. */
  | 'unreachable';

const REQUIRED_SECRETS = ['APPLE_TEAM_ID', 'APPLE_CLIENT_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY'] as const;

/**
 * Read the four Apple secrets out of the environment.
 *
 * Returns a `reason: 'configuration'` failure rather than throwing, because the
 * caller has to answer the request either way and a half-configured deployment
 * must not read as "Apple rejected this person's deletion".
 */
export function readAppleClientConfig(
  env: (name: string) => string | undefined,
): { ok: true; config: AppleClientConfig } | { ok: false; reason: 'configuration'; detail: string } {
  const missing = REQUIRED_SECRETS.filter(name => !(env(name) ?? '').trim());
  if (missing.length) {
    return { ok: false, reason: 'configuration', detail: `missing secrets: ${missing.join(', ')}` };
  }
  // Supabase secrets are single-line, so a .p8 pasted into one arrives with
  // literal backslash-n where its newlines were. Restoring them here means the
  // operator does not have to know that, and a correctly multi-line value is
  // unaffected.
  const privateKeyPem = (env('APPLE_PRIVATE_KEY') as string).replace(/\\n/g, '\n').trim();
  if (!/-----BEGIN PRIVATE KEY-----/.test(privateKeyPem)) {
    return {
      ok: false,
      reason: 'configuration',
      detail: 'APPLE_PRIVATE_KEY is not a PKCS#8 PEM (expected a -----BEGIN PRIVATE KEY----- block)',
    };
  }
  return {
    ok: true,
    config: {
      teamId: (env('APPLE_TEAM_ID') as string).trim(),
      clientId: (env('APPLE_CLIENT_ID') as string).trim(),
      keyId: (env('APPLE_KEY_ID') as string).trim(),
      privateKeyPem,
    },
  };
}

/** Base64url without padding, which is what JWS requires. */
function base64url(bytes: Uint8Array): string {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Decode the base64 body of a PEM block into its DER bytes. */
function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const raw = atob(body);
  const der = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) der[i] = raw.charCodeAt(i);
  return der;
}

/**
 * Build the ES256 client secret Apple requires in place of a static secret.
 *
 * WebCrypto's ECDSA signature output is already the raw r||s pair JWS wants, so
 * there is no DER unwrapping step here - a detail worth stating, because the
 * equivalent Node `crypto.sign` path produces DER and would need one.
 */
export async function createClientSecret(
  config: AppleClientConfig,
  deps: AppleRevocationDeps,
): Promise<string> {
  const subtle = deps.subtle ?? crypto.subtle;
  const issuedAt = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const header = base64url(utf8(JSON.stringify({ alg: 'ES256', kid: config.keyId, typ: 'JWT' })));
  const payload = base64url(utf8(JSON.stringify({
    iss: config.teamId,
    iat: issuedAt,
    exp: issuedAt + CLIENT_SECRET_TTL_SECONDS,
    aud: APPLE_AUDIENCE,
    sub: config.clientId,
  })));
  const key = await subtle.importKey(
    'pkcs8',
    pemToDer(config.privateKeyPem) as unknown as ArrayBuffer,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signature = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    utf8(`${header}.${payload}`) as unknown as ArrayBuffer,
  );
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

/**
 * The `sub` and `aud` claims out of an Apple `id_token`, without verifying its
 * signature.
 *
 * Skipping signature verification is deliberate and is what OpenID Connect
 * permits for a token collected directly from the token endpoint: this JWT
 * arrived in the HTTPS response to a request that was itself authenticated with
 * our ES256 client secret, so TLS plus that secret already establish where it
 * came from. Fetching and caching Apple's JWKS inside an edge function to
 * re-verify a token we just received over that channel would add a network
 * dependency and a key-rotation failure mode without adding a guarantee.
 *
 * What this IS used for is binding: proving the code came from the same Apple
 * ID the account is linked to. That check is not optional - see
 * `expectedAppleSubject`.
 */
function readIdTokenClaims(idToken: string): { sub: string; aud: string } | null {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as { sub?: unknown; aud?: unknown };
    const sub = typeof claims.sub === 'string' ? claims.sub : '';
    // Apple sends `aud` as a string for this flow.
    const aud = typeof claims.aud === 'string' ? claims.aud : '';
    return sub ? { sub, aud } : null;
  } catch {
    return null;
  }
}

/** Apple's short error slug, if the body is the JSON error shape it documents. */
async function appleErrorSlug(response: Response): Promise<string> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return `http ${response.status}`;
  }
  const slug = (body as { error?: unknown } | null)?.error;
  return typeof slug === 'string' && slug ? `${slug} (http ${response.status})` : `http ${response.status}`;
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

/**
 * Revoke the Apple authorization behind one authorization code.
 *
 * Apple's revoke endpoint takes a token, not a code, so this is two calls: the
 * code is exchanged for tokens, then the REFRESH token is revoked - revoking
 * the refresh token invalidates the whole authorization, where revoking only an
 * access token would leave the grant in place.
 *
 * The authorization code must be freshly minted: Apple's codes are single-use
 * and short-lived, so one captured at sign-in weeks ago is useless here. That
 * is why the client re-confirms with Apple at deletion time.
 */
export async function revokeAppleAuthorization(args: {
  authorizationCode: string;
  /**
   * The Apple subject (`sub`) the account being deleted is actually linked to,
   * taken from the GoTrue identity - NOT from the device.
   *
   * This is the difference between "an Apple authorization was revoked" and
   * "this account's Apple authorization was revoked", and the two come apart
   * routinely: `AppleAuthentication.signInAsync` always authenticates whichever
   * Apple ID is signed in to the DEVICE, while the Supabase session lives in
   * AsyncStorage and survives the device changing hands, an iCloud switch or a
   * restored backup. Without this check, deleting on a device now signed in as
   * a different Apple ID would revoke THAT person's grant (creating one first
   * if they had none), delete the account, and leave the account's own
   * authorization live - the exact failure the revocation exists to remove.
   */
  expectedAppleSubject: string;
  config: AppleClientConfig;
  deps: AppleRevocationDeps;
}): Promise<AppleRevocationResult> {
  const { authorizationCode, expectedAppleSubject, config, deps } = args;
  if (!authorizationCode.trim()) {
    return { ok: false, reason: 'authorization_rejected', detail: 'empty authorization code' };
  }
  if (!expectedAppleSubject.trim()) {
    // Refusing rather than revoking whatever turns up. A revocation that cannot
    // be attributed to the account is not evidence of anything.
    return { ok: false, reason: 'subject_mismatch', detail: 'no Apple subject on the account identity' };
  }

  let clientSecret: string;
  try {
    clientSecret = await createClientSecret(config, deps);
  } catch (e) {
    // An unusable private key lands here (wrong curve, truncated PEM, a
    // certificate pasted in place of a key). It is a deployment fault, so it
    // must not be reported as Apple refusing the person's request.
    return { ok: false, reason: 'configuration', detail: `client secret could not be signed: ${(e as Error).message}` };
  }

  let exchange: Response;
  try {
    exchange = await deps.fetch(APPLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        client_id: config.clientId,
        client_secret: clientSecret,
        code: authorizationCode,
        grant_type: 'authorization_code',
      }),
    });
  } catch (e) {
    return { ok: false, reason: 'unreachable', detail: `token endpoint: ${(e as Error).message}` };
  }
  if (!exchange.ok) {
    return { ok: false, reason: 'authorization_rejected', detail: await appleErrorSlug(exchange) };
  }

  let tokens: { refresh_token?: unknown; id_token?: unknown };
  try {
    tokens = await exchange.json();
  } catch (e) {
    return { ok: false, reason: 'unreachable', detail: `token endpoint returned unreadable JSON: ${(e as Error).message}` };
  }

  // --- bind the code to the account BEFORE revoking anything ----------------
  const idToken = typeof tokens.id_token === 'string' ? tokens.id_token : '';
  const claims = idToken ? readIdTokenClaims(idToken) : null;
  if (!claims) {
    return { ok: false, reason: 'unreachable', detail: 'token endpoint returned no readable id_token' };
  }
  if (claims.aud && claims.aud !== config.clientId) {
    return { ok: false, reason: 'subject_mismatch', detail: 'id_token audience is not this client' };
  }
  if (claims.sub !== expectedAppleSubject) {
    // Do NOT revoke. The grant this code identifies belongs to a different
    // Apple ID, which may well be another live iTala account on this device -
    // revoking it would break somebody who did not ask for anything.
    return { ok: false, reason: 'subject_mismatch', detail: 'the confirmation is for a different Apple ID' };
  }

  // Only the REFRESH token revokes the authorization. Revoking an access token
  // returns 200 from Apple and leaves the grant listed on the person's Apple
  // ID, so falling back to it would report success for a revocation that did
  // not happen - which is the whole failure this module exists to prevent.
  const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : '';
  if (!refreshToken) {
    return { ok: false, reason: 'revocation_rejected', detail: 'token endpoint returned no refresh token to revoke' };
  }

  let revoke: Response;
  try {
    revoke = await deps.fetch(APPLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        client_id: config.clientId,
        client_secret: clientSecret,
        token: refreshToken,
        token_type_hint: 'refresh_token',
      }),
    });
  } catch (e) {
    return { ok: false, reason: 'unreachable', detail: `revoke endpoint: ${(e as Error).message}` };
  }
  // Apple answers a successful revocation with 200 and an empty body.
  if (!revoke.ok) {
    return { ok: false, reason: 'revocation_rejected', detail: await appleErrorSlug(revoke) };
  }
  return { ok: true, tokenType: 'refresh_token' };
}
