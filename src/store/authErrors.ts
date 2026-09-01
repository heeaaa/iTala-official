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
 * Turn a raw auth failure into something worth showing a user.
 *
 * The point is to name the right layer. Every Supabase call on the reported
 * device failed with React Native's `TypeError: Network request failed`, and
 * the sign-in handlers answered by asking whether the provider was enabled in
 * Supabase - so the first thing that happened was someone checking a setting
 * that was already correct, twice, while the actual problem (the device could
 * not reach the host at all) went unmentioned. A message that points at the
 * wrong layer costs more time than no message.
 */
/**
 * Does this message mean the request never reached the host?
 *
 * React Native's fetch rejects with `TypeError: Network request failed` and no
 * further detail, which is the failure the reported logs are full of. Exported
 * so the auth layer and the sync layer classify it identically - they word the
 * advice differently, but they must not disagree about what happened.
 */
export function isNetworkFailure(raw: string | null | undefined): boolean {
  return /network request failed|failed to fetch|network error/i.test(raw ?? '');
}

export function describeAuthFailure(raw: string | null | undefined, provider?: string): string {
  const msg = (raw ?? '').trim();
  const who = provider ?? 'The provider';

  if (!msg || msg === 'timeout') {
    return "Couldn't reach the iTala server. Check this device's internet connection and try again.";
  }
  if (isNetworkFailure(msg)) {
    return "Couldn't reach the iTala server. If other apps are online, check for a VPN, a content blocker, or a wifi network still waiting for its sign-in page.";
  }
  if (/provider is not enabled|unsupported provider|validation_failed/i.test(msg)) {
    return `${who} sign-in is not enabled for this project yet.`;
  }
  if (/audience|bad_?jwt|invalid.*(id )?token/i.test(msg)) {
    return `${who} signed the token for a different app id than this project expects. In Expo Go that is normal — the token carries Expo Go's bundle id. See AUTH_SETUP.md: add host.exp.Exponent to the provider's Client IDs for development, or test in a build.`;
  }
  if (/anonymous.*(disabled|not enabled)/i.test(msg)) {
    return 'Guest access is turned off for this project, so the app cannot start a session.';
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
 */
export type SessionProbe = { answered: false } | { answered: true; hasSession: boolean };
export type SessionPlan = 'use-existing' | 'purge-and-sign-in-anonymously' | 'leave-alone';

export function sessionRecoveryPlan(probe: SessionProbe): SessionPlan {
  if (!probe.answered) return 'leave-alone';
  return probe.hasSession ? 'use-existing' : 'purge-and-sign-in-anonymously';
}
