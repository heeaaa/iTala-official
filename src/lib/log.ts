// ============================================================================
// The one place this app writes to the console (F-29).
//
// The auth and sync paths were calling console.log/console.warn directly, in
// about eighteen places. Nothing logged today is sensitive - the OAuth redirect
// URL is meant to be publicly registered and the rest are generic error strings -
// but nothing gated any of it either, so a future edit could start logging a
// token or an email in a release build and no reviewer or check would notice.
//
// Routing everything through here gives that a chokepoint. `static.test.js`
// CHECK 18 fails the build if a bare `console.` reappears in the auth or sync
// modules, so the gate cannot be bypassed by accident.
//
// Deliberately not solved with babel-plugin-transform-remove-console: that is a
// new build-time dependency for something two functions cover, and stripping at
// build time also removes the release diagnostics that are worth keeping.
// ============================================================================

// `__DEV__` is injected by the React Native / Expo bundler and is absent when
// this module is loaded outside it - notably in the esbuild test bundle. Treating
// "not defined" as production is the safe default: it means a missing global
// silences dev-only logging rather than leaking it.
const isDev = (): boolean => typeof __DEV__ !== 'undefined' && __DEV__ === true;

/**
 * Development-only diagnostics: setup hints, redirect URLs, flow tracing.
 * Anything whose audience is a developer at a keyboard, not a user's device log.
 */
export function devLog(...args: unknown[]): void {
  if (isDev()) console.log(...args);
}

/**
 * Development-only warning. For noise that is useful while working on a flow but
 * not worth carrying into release builds.
 */
export function devWarn(...args: unknown[]): void {
  if (isDev()) console.warn(...args);
}

/**
 * A real failure, kept in release builds on purpose.
 *
 * These are the lines that make a user's bug report actionable - a sign-in that
 * did not complete, a sync push the server rejected. Per CLAUDE.md an error is
 * never swallowed silently, so these must survive; the rule is that the message
 * describes what failed without including a credential, token, or personal
 * detail. Keep it that way: this is the function a future leak would go through.
 */
export function warn(...args: unknown[]): void {
  console.warn(...args);
}
