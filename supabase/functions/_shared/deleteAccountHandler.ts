// The `delete-account` Edge Function's whole request handler.
//
// WHY THIS IS NOT IN index.ts
//
// index.ts is a three-line `Deno.serve` wrapper so that everything with a
// decision in it lives in a module Node can load. `tests/appleRevocation.test.js`
// drives this function directly with a fake Apple and a fake Supabase, which is
// how the fail-closed ordering below is actually verified rather than asserted
// in a comment.
//
// WHAT THIS FUNCTION IS FOR
//
// Apple-linked deletion, and nothing else. A Google-only account is refused
// with `no_apple_identity` and keeps using the `delete_own_account` RPC
// directly, so the path that already worked is left alone.
//
// PRIVILEGE
//
// There is no service-role key here. The function verifies the caller's own
// JWT and then calls `delete_own_account` AS THAT CALLER, so the deletion is
// still authorised by `auth.uid()` inside the database. A stolen or forged
// request cannot delete somebody else's account, because it cannot present
// their access token.
//
// ORDERING (the point of the whole file)
//
//   revoke at Apple  ->  then delete the account
//
// Never the other way round. Once `auth.users` is gone the app has no way to
// prove anything to Apple, so a deletion that ran first would leave exactly the
// dangling authorization this function exists to remove. If revocation fails,
// nothing is deleted and the client is told to retry.

// `import type` is not stylistic here. Deno and the Supabase edge runtime strip
// types file by file, with no cross-module knowledge, so an interface imported
// through a value import can survive into the emitted JavaScript as a real
// binding - and then fail at request time with "does not provide an export
// named 'AppleRevocationDeps'". A type import cannot emit anything.

import type { AppleRevocationDeps } from './appleAuthorization.ts';
import { readAppleClientConfig, revokeAppleAuthorization } from './appleAuthorization.ts';

export interface DeleteAccountDeps extends AppleRevocationDeps {
  env: (name: string) => string | undefined;
}

/** Answers carry a machine-readable `error` slug; the client owns the wording. */
type Failure =
  | 'method_not_allowed'
  | 'missing_authorization'
  | 'invalid_session'
  | 'anonymous_session'
  | 'no_apple_identity'
  | 'apple_identity_unreadable'
  | 'apple_account_mismatch'
  | 'missing_authorization_code'
  | 'malformed_request'
  | 'configuration'
  | 'revocation_failed'
  | 'deletion_failed'
  | 'deletion_unconfirmed';

function fail(status: number, error: Failure, detail?: string): Response {
  // `detail` is Apple's or PostgREST's short slug, never a token and never a
  // user id. It exists so an operator reading a support report can tell
  // "expired code" apart from "wrong client id".
  return new Response(JSON.stringify(detail ? { error, detail } : { error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** One structured line per request. Deliberately carries no user id and no
 *  token - see the note at the top of appleAuthorization.ts. */
function log(outcome: string, detail?: string): void {
  console.log(JSON.stringify({ fn: 'delete-account', outcome, ...(detail ? { detail } : {}) }));
}

interface GoTrueUser {
  id?: unknown;
  is_anonymous?: unknown;
  identities?: unknown;
  app_metadata?: { provider?: unknown; providers?: unknown } | null;
}

function isAppleIdentity(user: GoTrueUser): boolean {
  const identities = Array.isArray(user.identities) ? user.identities : [];
  if (identities.some(i => (i as { provider?: unknown } | null)?.provider === 'apple')) return true;
  // Fallback for a project whose identities array is not expanded on this
  // endpoint. app_metadata.providers is the same list GoTrue derives it from.
  const meta = user.app_metadata ?? {};
  if (meta.provider === 'apple') return true;
  return Array.isArray(meta.providers) && meta.providers.includes('apple');
}

/** Collect subjects from every Apple identity verified by GoTrue for this user.
 * Multiple Apple identities can be linked to one account; their order must not
 * decide whether a fresh confirmation is accepted.
 */
function appleSubjects(user: GoTrueUser): string[] {
  const identities = Array.isArray(user.identities) ? user.identities : [];
  const subjects = new Set<string>();
  for (const raw of identities) {
    const identity = raw as { provider?: unknown; id?: unknown; identity_data?: { sub?: unknown } } | null;
    if (identity?.provider !== 'apple') continue;
    const sub = identity.identity_data?.sub;
    const subject = typeof sub === 'string' && sub.trim() ? sub : identity.id;
    if (typeof subject === 'string' && subject.trim()) subjects.add(subject);
  }
  return [...subjects];
}

export async function handleDeleteAccount(req: Request, deps: DeleteAccountDeps): Promise<Response> {
  if (req.method !== 'POST') return fail(405, 'method_not_allowed');

  const authorization = req.headers.get('Authorization') ?? '';
  if (!/^Bearer\s+\S+/i.test(authorization)) return fail(401, 'missing_authorization');

  const supabaseUrl = (deps.env('SUPABASE_URL') ?? '').replace(/\/+$/, '');
  const anonKey = deps.env('SUPABASE_ANON_KEY') ?? '';
  if (!supabaseUrl || !anonKey) {
    log('configuration', 'SUPABASE_URL or SUPABASE_ANON_KEY is not set');
    return fail(500, 'configuration', 'the function environment is incomplete');
  }

  let body: { appleAuthorizationCode?: unknown };
  try {
    body = (await req.json()) as { appleAuthorizationCode?: unknown };
  } catch {
    return fail(400, 'malformed_request');
  }

  // --- who is calling -------------------------------------------------------
  // The access token is verified by asking GoTrue, not by decoding it here: a
  // locally decoded JWT proves nothing about revocation, expiry or the project
  // it was minted for.
  let userResponse: Response;
  try {
    userResponse = await deps.fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: authorization },
    });
  } catch (e) {
    log('user_lookup_unreachable');
    return fail(502, 'invalid_session', `session could not be verified: ${(e as Error).message}`);
  }
  if (!userResponse.ok) {
    log('invalid_session', `http ${userResponse.status}`);
    return fail(401, 'invalid_session', `http ${userResponse.status}`);
  }
  let user: GoTrueUser;
  try {
    user = await userResponse.json();
  } catch {
    log('invalid_session', 'unreadable user payload');
    return fail(502, 'invalid_session', 'the session could not be read');
  }
  if (typeof user.id !== 'string' || !user.id) {
    log('invalid_session', 'no user id');
    return fail(401, 'invalid_session');
  }
  // A guest session has no Apple authorization and no account to delete.
  if (user.is_anonymous === true) {
    log('anonymous_session');
    return fail(403, 'anonymous_session');
  }
  // Google-only accounts belong on the RPC path. Answering here instead of
  // silently deleting keeps the two paths honest about what they verified.
  if (!isAppleIdentity(user)) {
    log('no_apple_identity');
    return fail(409, 'no_apple_identity');
  }

  // Which Apple ID this account belongs to. Without it the revocation cannot be
  // tied to the account, so there is nothing safe to do but refuse.
  const expectedAppleSubjects = appleSubjects(user);
  if (!expectedAppleSubjects.length) {
    log('apple_identity_unreadable');
    return fail(502, 'apple_identity_unreadable');
  }

  const authorizationCode =
    typeof body.appleAuthorizationCode === 'string' ? body.appleAuthorizationCode.trim() : '';
  if (!authorizationCode) {
    log('missing_authorization_code');
    return fail(400, 'missing_authorization_code');
  }

  const config = readAppleClientConfig(deps.env);
  if (!config.ok) {
    // The precise list of absent secrets goes to the function log, where an
    // operator can read it. It must NOT go back to the caller: `warn` on the
    // device is not dev-gated, so naming the project's missing secrets in the
    // response would put deployment state into release-build device logs.
    log('configuration', config.detail);
    return fail(500, 'configuration', 'the function environment is incomplete');
  }

  // --- 1. revoke at Apple ---------------------------------------------------
  const revocation = await revokeAppleAuthorization({
    authorizationCode,
    expectedAppleSubjects,
    config: config.config,
    deps,
  });
  if (!revocation.ok) {
    log(`revocation_failed:${revocation.reason}`, revocation.detail);
    // Fail closed. Nothing has been deleted, so the person can try again -
    // which is strictly better than an account that is gone while Apple still
    // lists iTala as authorised.
    if (revocation.reason === 'configuration') {
      return fail(500, 'configuration', 'the function environment is incomplete');
    }
    // A mismatch is not a transient failure and must not be worded as one: the
    // person is holding a device signed in to a different Apple ID, and only
    // they can fix that.
    if (revocation.reason === 'subject_mismatch') {
      return fail(409, 'apple_account_mismatch');
    }
    return fail(502, 'revocation_failed',
      `${revocation.reason}${revocation.detail ? `: ${revocation.detail}` : ''}`);
  }

  // --- 2. only then delete the account -------------------------------------
  let deletion: Response;
  try {
    deletion = await deps.fetch(`${supabaseUrl}/rest/v1/rpc/delete_own_account`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
  } catch (e) {
    log('deletion_unreachable_after_revocation');
    // The database may have committed before its response was lost. Let the
    // client reconcile the account instead of claiming deletion failed.
    return fail(502, 'deletion_unconfirmed', `revoked, but the account delete response was lost: ${(e as Error).message}`);
  }
  if (!deletion.ok) {
    if (deletion.status >= 500) {
      // An intermediary can return a 5xx after the database committed.
      log('deletion_unconfirmed_after_revocation', `http ${deletion.status}`);
      return fail(502, 'deletion_unconfirmed', `revoked, but the account delete returned http ${deletion.status}`);
    }
    log('deletion_failed_after_revocation', `http ${deletion.status}`);
    return fail(502, 'deletion_failed', `revoked, but the account delete failed with http ${deletion.status}`);
  }

  log('revoked_and_deleted', revocation.tokenType);
  return new Response(JSON.stringify({ revoked: true, deleted: true, tokenType: revocation.tokenType }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
