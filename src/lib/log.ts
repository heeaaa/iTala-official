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
 * Is this a development build?
 *
 * Exported so a SCREEN can make the same call this module makes: show the
 * server's own words to a developer, and never to a scorekeeper. Anything gated
 * on this must be a detail nobody needs to act on - the user-facing sentence has
 * to stand on its own without it.
 */
export const isDevBuild = isDev;

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
 * Development-only trace of the live game-state lifecycle.
 *
 * The bug class this app kept producing - a committed stat that reverts on its
 * own seconds later - is invisible in a stack trace and almost invisible on
 * screen: by the time anyone looks, the only evidence is a score that is wrong.
 * What makes it diagnosable is a single ordered stream naming every point state
 * can move: the action, the snapshot tick it was reconciled against, the push
 * that settled, and above all the snapshot that was REFUSED.
 *
 * One line per event, fixed field order, so the sequence reads at a glance:
 *
 *   [state] ACTION   t=ADD_EVENT game=g1 tokens=add:mtik9wk
 *   [state] PERSIST  ok t=ADD_EVENT tokens=add:mtik9wk
 *   [state] SNAPSHOT accepted at=44 leagues=2 source=realtime
 *   [state] PULL     queued source=realtime
 *   [state] SNAPSHOT REJECTED at=41 applied=44 reason=stale-snapshot source=auth:SIGNED_IN
 *
 * That last line is the one worth knowing exists. It is what a reverting
 * scoreboard used to look like from the inside, and it now names itself.
 *
 * Dev-only on purpose: it is one line per tap, which is noise a release build
 * has no use for. A real failure still goes through `warn` and survives.
 */
export function trace(topic: string, ...args: unknown[]): void {
  if (isDev()) console.log(`[state] ${topic}`, ...args);
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
