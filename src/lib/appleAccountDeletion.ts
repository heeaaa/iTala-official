// Sign in with Apple: the device half of account-deletion revocation.
//
// WHY THIS EXISTS
//
// Deleting the Supabase user and signing out locally never told Apple
// anything, so iTala stayed listed under Settings -> Apple ID -> Sign in with
// Apple with a live authorization. App Review guideline 5.1.1(v) requires the
// revoke call, and it can only happen on a server (it needs an ES256 client
// secret signed with the team's private key). The server half is
// supabase/functions/delete-account.
//
// WHY THE APPLE SHEET OPENS AGAIN AT DELETION TIME
//
// Apple's revoke endpoint takes a token, and getting one means exchanging an
// authorization code that is single-use and expires in minutes. A code captured
// at sign-in is therefore worthless weeks later. The alternatives were:
//
//   * exchange the code at SIGN-IN and store the refresh token server-side -
//     rejected: it means holding a long-lived credential for somebody's Apple
//     ID for the entire life of the account, to be used once, if ever.
//   * re-confirm with Apple at DELETION time and hand the fresh code straight
//     to the server, which uses it and drops it - chosen. One extra Face ID
//     confirmation on the rarest action in the app, and iTala never stores an
//     Apple credential at all.
//
// Everything here is pure or dependency-injected so tests/appleRevocation.test.js
// can drive the whole flow, including the failure orderings that matter.

import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { isNetworkFailure } from '../store/authErrors';

/**
 * Where somebody is sent when the in-app flow genuinely cannot complete.
 *
 * Both stores require account deletion to be available in the app, and this
 * flow can be blocked by things the person cannot fix from the delete screen -
 * a device signed out of iCloud, a non-iOS client, an undeployed function. Every
 * such message names this route, because "Please try again" on a permanent
 * failure is a dead end, and the privacy policy already promises this address
 * as the way to have data removed.
 */
const MANUAL_DELETION_CONTACT = 'hanna@itala.fyi';

/** Name of the Edge Function that revokes, then deletes. */
export const DELETE_ACCOUNT_FUNCTION = 'delete-account';

/**
 * Long by the standards of this module's neighbours, and deliberately so: the
 * function makes two round trips to Apple and one to PostgREST before it
 * answers. The usual 8s budget would time out a revocation that was about to
 * succeed, and a timeout here reads to the person as "nothing was deleted"
 * while the server may in fact have finished.
 */
export const DELETE_ACCOUNT_TIMEOUT_MS = 20_000;

export interface AppleIdentityUser {
  identities?: readonly ({ provider?: string | null } | null)[] | null;
  app_metadata?: { provider?: string | null; providers?: readonly string[] | null } | null;
}

/**
 * Is this account linked to Apple?
 *
 * Used to CHOOSE a deletion path, never as the authorisation for one: the Edge
 * Function re-checks the identity server-side against the caller's own token,
 * so a stale client-side answer cannot skip revocation.
 */
export function hasAppleIdentity(user: AppleIdentityUser | null | undefined): boolean {
  if (!user) return false;
  const identities = user.identities ?? [];
  if (identities.some(identity => identity?.provider === 'apple')) return true;
  const meta = user.app_metadata ?? {};
  if (meta.provider === 'apple') return true;
  return Array.isArray(meta.providers) && meta.providers.includes('apple');
}

export type AppleAuthorizationRequest =
  | { status: 'ok'; code: string }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string; diagnosis: string };

/**
 * Ask Apple for a fresh, single-use authorization code.
 *
 * No scopes are requested: the account already exists, so name and email are
 * not wanted, and asking for them again would be a second consent screen for
 * data that is about to be deleted.
 */
export async function requestAppleAuthorizationCode(): Promise<AppleAuthorizationRequest> {
  // The Apple sheet only exists on iOS - `signInAsync` throws
  // UnavailabilityError elsewhere. Checking first turns "Apple couldn't confirm
  // the request on this device. Please try again." (untrue, and unfixable by
  // trying again) into a sentence that says what is actually going on. This is
  // reachable if an account ever carries an Apple identity while being used
  // from Android or web.
  if (Platform.OS !== 'ios') {
    return {
      status: 'failed',
      message: 'This account is linked to Sign in with Apple, which can only be confirmed on an '
        + `iPhone or iPad. Delete the account from an iOS device, or email ${MANUAL_DELETION_CONTACT} `
        + 'and we will delete it for you.',
      diagnosis: `Apple deletion attempted on Platform.OS=${Platform.OS}; the native sheet is iOS-only.`,
    };
  }
  try {
    const credential = await AppleAuthentication.signInAsync({});
    if (!credential.authorizationCode) {
      // Defence in depth rather than a live path: expo-apple-authentication
      // already throws ERR_REQUEST_FAILED when the credential is missing its
      // authorizationCode. Kept because a silent null here would mean sending
      // nothing to revoke, and the native module is not ours.
      return {
        status: 'failed',
        message: "Apple didn't confirm the request. Please try again, or email "
          + `${MANUAL_DELETION_CONTACT} if it keeps happening.`,
        diagnosis: 'signInAsync returned no authorizationCode, so there is nothing to revoke.',
      };
    }
    return { status: 'ok', code: credential.authorizationCode };
  } catch (e) {
    const code = (e as { code?: string })?.code;
    // Closing the sheet is an answer, not a fault. It must leave the account
    // exactly as it was, with nothing on screen accusing anybody of anything.
    if (code === 'ERR_REQUEST_CANCELED') return { status: 'cancelled' };
    const raw = (e as Error)?.message ?? '';
    return {
      status: 'failed',
      message: isNetworkFailure(raw)
        ? "Couldn't reach Apple. Check your internet connection and try again."
        // Not "please try again" alone: a device signed out of iCloud, or one
        // whose Apple ID authentication is failing, will fail every retry.
        : 'Apple could not confirm the request on this device. Check you are signed in to iCloud '
          + `and try again, or email ${MANUAL_DELETION_CONTACT} to have the account deleted for you.`,
      diagnosis: `AppleAuthentication.signInAsync threw${code ? ` (${code})` : ''}: ${raw}`,
    };
  }
}

/** What the Edge Function answered, in the shape supabase-js hands back. */
export interface FunctionAnswer {
  data: unknown;
  error: unknown;
}

export type AppleDeletionOutcome =
  /** Revoked at Apple AND deleted server-side. */
  | { status: 'deleted' }
  /** The person closed the Apple sheet. Nothing changed; say nothing. */
  | { status: 'cancelled' }
  /**
   * The server says this account has no Apple identity, so there is nothing to
   * revoke. The caller should fall through to the plain `delete_own_account`
   * RPC - trusting the server's view of the identities over the client's.
   */
  | { status: 'not-apple' }
  /**
   * The request never got an answer (timeout, or the transport failed), so
   * whether the server finished is UNKNOWN. The caller must find out before
   * telling anybody anything - signing the person out here would claim a
   * deletion that may not have happened, and reporting a failure would be
   * wrong if it did.
   */
  | { status: 'unconfirmed'; message: string; diagnosis: string }
  /** Nothing was deleted (or, for `deletion_failed`, revocation happened and
   *  deletion did not). Either way it is safe to try again. */
  | { status: 'failed'; message: string; diagnosis: string };

/** Slugs the Edge Function answers with. Kept beside the wording they map to. */
const FAILURE_WORDING: Record<string, string> = {
  missing_authorization_code:
    "Apple didn't confirm the request. Nothing was deleted - please try again.",
  authorization_rejected:
    "Apple didn't accept the confirmation. Nothing was deleted - please try again.",
  revocation_failed:
    "iTala couldn't ask Apple to stop using your Apple ID, so nothing was deleted. Please try again.",
  deletion_failed:
    'iTala has stopped using your Apple ID, but your account could not be deleted. Please try again.',
  // The device is signed in to a different Apple ID than the account was
  // created with. Nothing was revoked and nothing was deleted, deliberately:
  // the grant the device just offered belongs to somebody else.
  apple_account_mismatch:
    'This account was created with a different Apple ID than the one signed in on this device. '
    + 'Sign in to the device with that Apple ID and try again, or email '
    + `${MANUAL_DELETION_CONTACT} to have the account deleted for you.`,
  apple_identity_unreadable:
    "iTala couldn't confirm which Apple ID this account uses, so nothing was deleted. Please try "
    + `again, or email ${MANUAL_DELETION_CONTACT} to have it deleted for you.`,
  configuration:
    "Account deletion isn't available right now. Please try again later, or email "
    + `${MANUAL_DELETION_CONTACT} to have your account deleted.`,
  invalid_session:
    'Your session has expired. Sign in again, then delete your account.',
  anonymous_session:
    'There is no account signed in on this device to delete.',
  malformed_request:
    "iTala couldn't send the request. Please update the app and try again.",
  method_not_allowed:
    "Account deletion isn't available right now. Please try again later.",
};

const FALLBACK_WORDING = 'Your account could not be deleted. Nothing was changed - please try again.';

/** Read the `{ error, detail }` body out of whatever supabase-js reported. */
async function readFailure(error: unknown): Promise<{ slug: string; detail: string }> {
  const message = ((error as { message?: unknown })?.message ?? '') as string;
  // supabase-js wraps a non-2xx as FunctionsHttpError and hangs the untouched
  // Response off `.context`, so the function's own slug is only reachable by
  // reading that body. Without this the person would get the generic
  // "Edge Function returned a non-2xx status code" for every distinct cause.
  const context = (error as { context?: unknown })?.context as
    | { json?: () => Promise<unknown> }
    | undefined;
  if (context && typeof context.json === 'function') {
    try {
      const body = (await context.json()) as { error?: unknown; detail?: unknown } | null;
      const slug = typeof body?.error === 'string' ? body.error : '';
      const detail = typeof body?.detail === 'string' ? body.detail : '';
      if (slug) return { slug, detail };
    } catch {
      // An unreadable body is not worth failing over. Fall through: the outcome
      // is still a refusal, it just gets the generic wording, and the raw
      // message is kept in the diagnosis for the log.
    }
  }
  // `isNetworkFailure` knows the transport's own spellings, but supabase-js
  // wraps a failed fetch to an Edge Function in its OWN sentence - "Failed to
  // send a request to the Edge Function" (FunctionsFetchError) - which matches
  // none of them. Without this clause the single most common failure on a phone
  // at a court, no connection, would be described with the generic fallback
  // instead of "check your internet connection".
  if (typeof message === 'string'
      && (message === 'timeout' || isNetworkFailure(message) || /failed to send a request/i.test(message))) {
    return { slug: 'transport', detail: message };
  }
  return { slug: '', detail: typeof message === 'string' ? message : '' };
}

/**
 * Revoke at Apple and delete the account, in that order, or change nothing.
 *
 * `invoke` is injected by the caller already wrapped in its timeout - this
 * module must not be the place that decides a Supabase call may hang.
 */
export async function deleteAppleAccount(deps: {
  requestAuthorizationCode: () => Promise<AppleAuthorizationRequest>;
  invoke: (body: { appleAuthorizationCode: string }) => Promise<FunctionAnswer>;
}): Promise<AppleDeletionOutcome> {
  const authorization = await deps.requestAuthorizationCode();
  if (authorization.status === 'cancelled') return { status: 'cancelled' };
  if (authorization.status === 'failed') {
    return { status: 'failed', message: authorization.message, diagnosis: authorization.diagnosis };
  }

  let answer: FunctionAnswer;
  try {
    answer = await deps.invoke({ appleAuthorizationCode: authorization.code });
  } catch (e) {
    // A thrown invoke is the same "did it finish?" ambiguity as a timeout.
    const raw = (e as Error)?.message ?? '';
    return {
      status: 'unconfirmed',
      message: isNetworkFailure(raw)
        ? "Couldn't reach iTala. Check your internet connection and try again."
        : FALLBACK_WORDING,
      diagnosis: `${DELETE_ACCOUNT_FUNCTION} threw: ${raw}`,
    };
  }

  if (answer?.error) {
    const { slug, detail } = await readFailure(answer.error);
    // The server's own identity check disagrees with ours. Its answer wins, and
    // the caller falls back to the RPC rather than refusing to delete.
    if (slug === 'no_apple_identity') return { status: 'not-apple' };
    if (slug === 'transport') {
      // NOT 'failed'. The function revokes and deletes in one request, so a
      // request that never came back may have completed on the server. The
      // caller has to check before reporting anything.
      return {
        status: 'unconfirmed',
        message: "Couldn't reach iTala. Check your internet connection and try again.",
        diagnosis: `${DELETE_ACCOUNT_FUNCTION} did not answer: ${detail}`,
      };
    }
    return {
      status: 'failed',
      message: FAILURE_WORDING[slug] ?? FALLBACK_WORDING,
      diagnosis: `${DELETE_ACCOUNT_FUNCTION} refused: ${slug || 'no slug'}${detail ? ` - ${detail}` : ''}`,
    };
  }

  // A 2xx alone is not evidence. The function reports both halves, and a
  // response that does not confirm BOTH is treated as a failure rather than
  // silently signing the person out of an account that still exists and an
  // Apple authorization that was never revoked.
  const data = answer?.data as { revoked?: unknown; deleted?: unknown } | null;
  if (data?.revoked !== true || data?.deleted !== true) {
    return {
      status: 'failed',
      message: FALLBACK_WORDING,
      diagnosis: `${DELETE_ACCOUNT_FUNCTION} answered without confirming revocation and deletion: ${JSON.stringify(data)}`,
    };
  }
  return { status: 'deleted' };
}
