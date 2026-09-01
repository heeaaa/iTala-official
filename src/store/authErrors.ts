// ============================================================================
// Auth failure handling: who a message belongs to, what it should say, and what
// a non-answer means.
//
// Pulled out of AdminProvider deliberately. All three of these were decisions
// buried inside a React component, so the only way to check them was to read
// the component - and all three were wrong in a way that reading did not catch:
//
//   * one shared `lastError` string, so a failed Apple sign-in was still on
//     screen inside the "Admin access" modal opened afterwards
//   * a network failure reported as "Is the Apple provider enabled in Supabase
//     with this app's bundle ID?", which sent someone to check a setting that
//     was already correct
//   * a timed-out getSession treated as "this device is signed out", which then
//     purged the stored tokens
//
// As pure functions they are covered by tests/reducer.test.js instead.
// ============================================================================

/** Which user-facing flow a failure belongs to. */
export type AuthScope = 'signin' | 'admin' | 'account' | 'code';

/** Current failure per flow. Absent key = that flow has nothing to report. */
export type AuthErrors = Partial<Record<AuthScope, string>>;

/**
 * Set (or clear, with null) the message for ONE flow, leaving the others alone.
 *
 * Returns the same object when nothing changed, so React can skip the render.
 */
export function setScopedError(prev: AuthErrors, scope: AuthScope, message: string | null): AuthErrors {
  if (message === null) {
    if (prev[scope] === undefined) return prev;
    const next = { ...prev };
    delete next[scope];
    return next;
  }
  if (prev[scope] === message) return prev;
  return { ...prev, [scope]: message };
}

/** Clear one flow's message, or every flow's when `scope` is omitted. */
export function clearScopedError(prev: AuthErrors, scope?: AuthScope): AuthErrors {
  if (scope) return setScopedError(prev, scope, null);
  return Object.keys(prev).length === 0 ? prev : {};
}

/** Read one flow's message. Never returns another flow's. */
export function errorForScope(errors: AuthErrors, scope: AuthScope): string | null {
  return errors[scope] ?? null;
}

/**
 * Does this message mean the request never reached the host?
 *
 * React Native's fetch rejects with `TypeError: Network request failed` and no
 * further detail, which is the failure the reported logs are full of. Shared so
 * the auth layer and the sync layer classify it identically - they word the
 * advice differently, but they must not disagree about what happened.
 */
export function isNetworkFailure(raw: string | null | undefined): boolean {
  return /network request failed|failed to fetch|network error/i.test(raw ?? '');
}

// ---------------------------------------------------------------------------
// TWO AUDIENCES, TWO FUNCTIONS.
//
// These used to be one. The result was that a person trying to sign in was told
// to "Add this exact URL to Supabase -> Authentication -> URL Configuration",
// and which bundle id Expo Go signs tokens with. None of that is actionable by
// someone holding a phone at a basketball court, and most of it describes a
// dashboard they cannot open and should not know exists.
//
// So: `describeAuthFailure` is what a PERSON reads. It says what happened and
// what they can do, in plain words, and never names Supabase, a redirect URL, a
// bundle id, or a config screen. `diagnoseAuthFailure` is what goes to the log
// for whoever is building the app - that is where the actionable configuration
// detail belongs, and it can be as specific as it likes.
//
// Every call site pairs them: log the diagnosis, show the description.
// ---------------------------------------------------------------------------

/** What a person sees. Plain, short, and never about configuration. */
export function describeAuthFailure(raw: string | null | undefined, provider?: string): string {
  const msg = (raw ?? '').trim();
  const who = provider ?? 'Sign-in';

  if (!msg || msg === 'timeout' || isNetworkFailure(msg)) {
    return "Couldn't reach iTala. Check your internet connection and try again.";
  }
  if (/too many attempts/i.test(msg)) {
    // The server writes this one for a person, and it carries the wait.
    return msg;
  }
  if (/provider is not enabled|unsupported provider|validation_failed/i.test(msg)) {
    return `${who} sign-in isn't available right now. Try another way to sign in.`;
  }
  if (/audience|bad_?jwt|invalid.*(id )?token/i.test(msg)) {
    return `${who} couldn't finish signing you in on this device. Try again, or use another sign-in option.`;
  }
  if (/anonymous.*(disabled|not enabled)/i.test(msg)) {
    return "iTala couldn't start a session. Try again in a moment.";
  }
  return `${who} didn't complete. Please try again.`;
}

/**
 * What the developer log gets. Names the layer, the setting and the fix.
 *
 * This is the half that was costing real time when it was missing: every
 * Supabase call on the reported device failed with React Native's
 * `TypeError: Network request failed`, while the app asked whether the provider
 * was enabled - so a correct setting got checked twice and the actual cause went
 * unmentioned. Keep this specific; it is not user-visible.
 */
export function diagnoseAuthFailure(raw: string | null | undefined, provider?: string): string {
  const msg = (raw ?? '').trim();
  const who = provider ?? 'provider';

  if (!msg) return 'failed with no reason given';
  if (msg === 'timeout') return 'timed out with no answer - host unreachable, or the client is still initialising';
  if (isNetworkFailure(msg)) {
    return `${msg} - the request never reached the host. Check the device is genuinely online (VPN, content blocker, captive portal) and that the project is not paused.`;
  }
  if (/provider is not enabled|unsupported provider|validation_failed/i.test(msg)) {
    return `${msg} - enable the ${who} provider in Supabase -> Authentication -> Providers.`;
  }
  if (/audience|bad_?jwt|invalid.*(id )?token/i.test(msg)) {
    return `${msg} - the token audience does not match the provider's Client IDs. In Expo Go the audience is host.exp.Exponent, not com.bpbl.itala. See docs/AUTH_SETUP.md.`;
  }
  if (/anonymous.*(disabled|not enabled)/i.test(msg)) {
    return `${msg} - enable Anonymous sign-in in Supabase -> Authentication -> Providers.`;
  }
  if (/both auth code and code verifier should be non-empty|code verifier|code_verifier/i.test(msg)) {
    return `${msg} - the PKCE verifier written when sign-in started was not found at exchange time. It lives in AsyncStorage under the auth storage key, so anything clearing storage mid-flow (a sign-out, a second client instance) loses it.`;
  }
  if (/redirect|callback/i.test(msg)) {
    return `${msg} - check Supabase -> Authentication -> URL Configuration -> Redirect URLs against the redirect the app logs when sign-in starts.`;
  }
  return msg;
}

/**
 * What a session probe means, and what may be done about it.
 *
 * `probe` is the OUTCOME of reading the stored session, not its value:
 *   answered:false  the call never came back (timed out)
 *   answered:true, hasSession:true   a usable session is in storage
 *   answered:true, hasSession:false  storage genuinely holds nothing usable
 *
 * The distinction is the whole point. supabase-js resolves getSession() only
 * after its own initialisation, and that initialisation refreshes an expired
 * access token over the network - so on a device that cannot reach the server
 * the call simply does not answer. Collapsing that into "no session" is what
 * made a bad connection purge the stored tokens and mint a new anonymous user,
 * quietly signing people out and reassigning everything they owned.
 *
 * A non-answer is never grounds for a destructive action.
 *
 * Note what is NOT here any more: a "purge" step. Boot used to call
 * `signOut({ scope: 'local' })` whenever the probe answered "no session", to
 * clear a stale refresh token. That call also deletes the PKCE code verifier
 * (auth-js `_signOut`: `scope !== 'others'` removes `<storageKey>-code-verifier`),
 * and a Google sign-in started while boot was still running would have its
 * verifier deleted between writing it and exchanging the code - so the exchange
 * failed with nothing to exchange against. It is also redundant: an unusable
 * stored session is removed by `__loadSession` before it can answer "no
 * session" at all, so by the time this plan is chosen there is nothing left to
 * purge. See `sign-in-anonymously`.
 */
export type SessionProbe = { answered: false } | { answered: true; hasSession: boolean };
export type SessionPlan = 'use-existing' | 'sign-in-anonymously' | 'leave-alone';

export function sessionRecoveryPlan(probe: SessionProbe): SessionPlan {
  if (!probe.answered) return 'leave-alone';
  return probe.hasSession ? 'use-existing' : 'sign-in-anonymously';
}
