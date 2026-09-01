import React, { createContext, useContext, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import * as AppleAuthentication from 'expo-apple-authentication';
import { getSupabase, SYNC_ENABLED } from '../sync/supabase';
import { isNetworkFailure } from './authErrors';
import { devLog, warn } from '../lib/log';
import {
  AuthErrors, AuthScope, clearScopedError, describeAuthFailure, diagnoseAuthFailure,
  errorForScope, sessionRecoveryPlan, setScopedError,
} from './authErrors';

export type { AuthScope } from './authErrors';

// ---------------------------------------------------------------------------
// Auth + roles module.
//
// Three roles, derived in ONE place (deriveRole below):
//   guest — default. No sign-in. Read-only everywhere; cannot share cards.
//   user  — signed in with Google. Everything guest can do + share cards.
//   admin — Google email on ADMIN_EMAILS (or password-elevated backup).
//           Full write access: live stat entry, league/roster/game editing.
//
// SYNCED mode: role is backed by Supabase Auth. Devices boot into an anonymous
//   session (guest) so RLS-protected reads and realtime keep working. Google
//   sign-in replaces the anonymous session; email is checked against the
//   allowlist client-side (UI gating) AND server-side (sync_admin_role RPC →
//   profiles.is_admin → RLS actually permits writes).
// LOCAL-ONLY mode (no Supabase env vars): there is no auth backend, so the
//   device is trusted — role is 'user' by default (sharing works offline) and
//   the password lock elevates to 'admin', exactly like before.
//
// The password flow (unlock/lock + elevate_to_admin RPC) is kept intact as a
// hidden emergency backup — see the hidden lock gesture on LeaguesScreen.
//
// Hard rule in this module (unchanged): NO Supabase call is ever awaited
// without a timeout. supabase-js auth methods can hang in React Native when
// storage/locks stall; every call below races a timeout and always resolves.
// ---------------------------------------------------------------------------

// Required so the in-app browser closes correctly after the OAuth redirect.
WebBrowser.maybeCompleteAuthSession();

// Local-only fallback password (no Supabase configured, so there is no server to
// verify against). Read from the environment, never written in this file:
// EXPO_PUBLIC_* values are inlined into the JS bundle by Metro, so a literal here
// is both shipped in the binary AND published in the repo — and a password in git
// history cannot be un-published.
//
// Unset means the local password path is closed, which is the right default. It
// only matters for a build with no Supabase project at all; in SYNCED mode the
// server does the checking (hashed, throttled — see elevate_to_admin).
//
// Even when set this is a UI speed bump, not a security boundary: in local-only
// mode the device is the only authority and anyone who can read the bundle can
// read the value. The real boundary is RLS, which only exists in SYNCED mode.
const LOCAL_FALLBACK_PASSWORD = process.env.EXPO_PUBLIC_ADMIN_LOCAL_PASSWORD ?? '';

/** Length-independent comparison, so a wrong guess cannot be narrowed by timing. */
function slowEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// ADMIN ALLOWLIST — single source of truth on the client.
// Keep this in sync with the `admin_emails` table in supabase/schema.sql
// (the table is what RLS actually enforces; this list drives the UI).
// ---------------------------------------------------------------------------
export const ADMIN_EMAILS: readonly string[] = [
  'abejoharold@gmail.com',
  'abejohanna@gmail.com',
  'aeronjosephsantos@gmail.com',
  'santos.ajhea@gmail.com',
].map(e => e.toLowerCase());

export type Role = 'guest' | 'user' | 'admin';

export interface AuthUser {
  id: string;
  email: string;
  /** Display name from the Google account (falls back to the email). */
  name: string;
  /** Google profile photo URL, if any. */
  avatarUrl: string | null;
}

function isAdminEmail(email: string | null | undefined): boolean {
  return !!email && ADMIN_EMAILS.includes(email.toLowerCase());
}

/** The ONE place a role is computed. Components must consume `role`
 *  (or the derived `isAdmin`) — never check emails or passwords directly. */
function deriveRole(opts: { synced: boolean; user: AuthUser | null; serverAdmin: boolean; localUnlocked: boolean }): Role {
  if (!opts.synced) {
    // Local-only: device is trusted; the password lock gates admin actions.
    return opts.localUnlocked ? 'admin' : 'user';
  }
  if (opts.user) {
    return isAdminEmail(opts.user.email) || opts.serverAdmin ? 'admin' : 'user';
  }
  // Anonymous session (or none). serverAdmin covers the password-elevated
  // anonymous device (the hidden-lock backup path).
  return opts.serverAdmin ? 'admin' : 'guest';
}

/**
 * Race a promise against a deadline, reporting WHICH happened.
 *
 * `withTimeout` below keeps the old convenience shape (resolve to a fallback),
 * but a fallback alone is not enough information for every caller. A
 * `getSession` that times out and a `getSession` that genuinely finds no
 * session both produce `{ session: null }`, and ensureSession used to treat the
 * two identically - purging the stored tokens and minting a fresh anonymous
 * user. On a device that cannot reach the server that quietly signs the person
 * out and reassigns everything they own. Callers that must not confuse "no" with
 * "no answer" use this instead.
 */
type Raced<T> = { ok: true; value: T } | { ok: false; timedOut: true };

function raceTimeout<T>(p: PromiseLike<T>, ms: number, label: string): Promise<Raced<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve(p).then((value): Raced<T> => ({ ok: true, value })),
    new Promise<Raced<T>>((resolve) => {
      timer = setTimeout(() => {
        warn(`[auth] ${label} timed out after ${ms}ms`);
        resolve({ ok: false, timedOut: true });
      }, ms);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

// Wrap any promise so it can never hang the UI. Returns `fallback` on timeout.
function withTimeout<T>(p: PromiseLike<T>, ms: number, fallback: T, label: string): Promise<T> {
  return raceTimeout(p, ms, label).then(r => (r.ok ? r.value : fallback));
}

/**
 * Where the provider is told to send the browser back, and whether this build
 * can actually receive it.
 *
 * THIS IS THE GOOGLE SIGN-IN BUG. Expo Go serves the app over `exp://<lan-ip>:8081`,
 * so `Linking.createURL` produces an exp:// deep link. Supabase only honours a
 * `redirect_to` that is on its allowlist; anything else silently falls back to
 * the project's Site URL. With the Expo Go URL missing from the allowlist, the
 * flow finished by sending Safari to the Site URL — `itala://auth-callback` —
 * a scheme that only the standalone build registers. Safari, handed a URL no
 * installed app claims, says:
 *
 *     "Safari cannot open the page because the address is invalid."
 *
 * which is the reported symptom exactly, and reads like a broken app rather
 * than a missing line in a dashboard. Nothing about it is fixable from here:
 * the allowlist entry has to exist. What IS fixable is saying so.
 */
function oauthRedirect(): { redirectTo: string; inExpoGo: boolean } {
  const redirectTo = Linking.createURL('auth-callback');
  // A dev/release build deep-links through the app's own scheme (app.json
  // `scheme`); only Expo Go hands out exp://.
  const inExpoGo = /^exps?:\/\//i.test(redirectTo);
  return { redirectTo, inExpoGo };
}

/** The instruction that actually resolves an unregistered redirect. */
function allowlistHint(redirectTo: string): string {
  return `Add this exact URL to Supabase → Authentication → URL Configuration → Redirect URLs, then try again:\n\n${redirectTo}`;
}

interface AdminCtx {
  /** Centralized role. All permission checks in the UI go through this. */
  role: Role;
  /** Convenience: role === 'admin'. Kept so existing screens don't change. */
  isAdmin: boolean;
  /** The signed-in Google account, or null for guests/anonymous sessions. */
  user: AuthUser | null;
  /** Supabase auth uid (anonymous or Google). Null in local-only mode. */
  userId: string | null;
  /** True while a Google sign-in round trip is in flight. */
  authBusy: boolean;
  /** The most recent failure IN THIS FLOW, or null.
   *
   *  Scoped rather than global. There used to be one `lastError` string shared
   *  by the sign-in sheet, the backup-admin password modal, the account screen
   *  and the drop-in setup screen, and nothing cleared it. So a failed Apple
   *  sign-in was still on screen inside the "Admin access" modal opened
   *  afterwards - an error about one thing presented as an error about
   *  another. A message belongs to the flow that produced it. */
  errorFor: (scope: AuthScope) => string | null;
  /** Drop the message for one flow (or all of them). Screens call this when
   *  they open a sheet, so a stale failure never greets the next attempt. */
  clearError: (scope?: AuthScope) => void;
  /** Launches the Google OAuth flow. Resolves to the resulting role, or null
   *  if the user cancelled / sign-in failed. Never hangs. */
  signInWithGoogle: () => Promise<Role | null>;
  /** True when native Sign in with Apple can be offered (iOS device). */
  appleAvailable: boolean;
  /** Launches native Sign in with Apple (App Store Guideline 4.8 requires
   *  offering it alongside Google). Same role resolution as Google. */
  signInWithApple: () => Promise<Role | null>;
  /** Permanently deletes the signed-in account server-side (App Store
   *  5.1.1(v) / Play policy requirement), then returns the device to a guest
   *  session. League/game data is untouched. Resolves true on success. */
  deleteAccount: () => Promise<boolean>;
  /** Signs out of Google and returns the device to a guest (anonymous) session. */
  signOut: () => Promise<void>;
  /** This user's per-league roles (league id → role). Supers bypass this. */
  memberships: Record<string, 'owner' | 'scorekeeper'>;
  /** Can run games / edit players in this league. */
  canScore: (league: { id: string; kind?: string; isShared?: boolean }) => boolean;
  canScoreGame: (league: { id: string; kind?: string; isShared?: boolean }, game?: { createdBy?: string }) => boolean;
  /** Can restructure this league (settings, teams, members, delete). */
  isOwner: (league: { id: string; kind?: string; isShared?: boolean }) => boolean;
  /** Redeems any invite code (create-league / co-owner / scorekeeper). */
  reloadMemberships: () => Promise<void>;
  redeemCode: (code: string) => Promise<
    | { type: 'create' }
    | { type: 'joined'; leagueId: string; role: 'owner' | 'scorekeeper'; leagueName: string }
    | { type: 'error'; message: string }
  >;
  /** Super Admins: mint a single-use league-creation code. */
  createCreationCode: () => Promise<string | null>;
  /** Owner tools for the Members section. All resolve null/false on failure. */
  getLeagueCodes: (leagueId: string) => Promise<{ owner: string; scorekeeper: string } | null>;
  regenerateLeagueCode: (leagueId: string, role: 'owner' | 'scorekeeper') => Promise<string | null>;
  listMembers: (leagueId: string) => Promise<{ user_id: string; role: string; name: string; email: string | null }[] | null>;
  removeMember: (leagueId: string, userId: string) => Promise<boolean>;
  /** BACKUP password elevation (hidden lock). Resolves true on success. */
  unlock: (password: string) => Promise<boolean>;
  /** Drops password elevation. */
  lock: () => Promise<void>;
}

const Ctx = createContext<AdminCtx | null>(null);

export function AdminProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [serverAdmin, setServerAdmin] = useState(false);   // profiles.is_admin (synced mode)
  const [localUnlocked, setLocalUnlocked] = useState(false); // password unlock (local-only mode)
  const [authBusy, setAuthBusy] = useState(false);
  const [errors, setErrors] = useState<AuthErrors>({});

  const setError = (scope: AuthScope, message: string | null) =>
    setErrors(prev => setScopedError(prev, scope, message));
  const errorFor = (scope: AuthScope): string | null => errorForScope(errors, scope);
  const clearError = (scope?: AuthScope) => setErrors(prev => clearScopedError(prev, scope));
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [memberships, setMemberships] = useState<Record<string, 'owner' | 'scorekeeper'>>({});

  // Native Apple sign-in exists only on iOS hardware; on Android/web the
  // module reports unavailable and the UI simply never shows the button.
  useEffect(() => {
    if (Platform.OS !== 'ios' || !SYNC_ENABLED) return;
    AppleAuthentication.isAvailableAsync().then(setAppleAvailable).catch(() => setAppleAvailable(false));
  }, []);

  const role = deriveRole({ synced: SYNC_ENABLED, user, serverAdmin, localUnlocked });

  const refreshMemberships = async (sb: NonNullable<ReturnType<typeof getSupabase>>) => {
    const res = await withTimeout(sb.rpc('my_memberships'), 6000, { data: null, error: null } as any, 'my_memberships');
    if (Array.isArray(res?.data)) {
      const map: Record<string, 'owner' | 'scorekeeper'> = {};
      for (const m of res.data as { league_id: string; role: 'owner' | 'scorekeeper' }[]) map[m.league_id] = m.role;
      setMemberships(map);
    }
  };

  // Public, no-arg refresh — call after creating a league so the creator's new
  // owner membership (inserted server-side by create_league) is reflected
  // locally right away, instead of only after an app reload.
  const reloadMemberships = async () => {
    const sb = getSupabase();
    if (sb) await refreshMemberships(sb);
  };

  // Boot: restore any persisted session (Google or anonymous). If none exists,
  // establish an anonymous session so RLS reads + realtime work for guests.
  // Never blocks rendering.
  useEffect(() => {
    if (!SYNC_ENABLED) return;
    const sb = getSupabase();
    if (!sb) return;
    let cancelled = false;

    (async () => {
      const restored = await ensureSession(sb);
      if (cancelled || !restored) return;
      setUserId(restored.uid);
      setUser(restored.user);
      if (restored.user) {
        // Refresh the server-side admin flag from the email allowlist
        // (covers accounts created before an allowlist edit).
        await withTimeout(sb.rpc('sync_admin_role'), 6000, { data: null, error: null } as any, 'sync_admin_role');
      }
      const flag = await readAdminFlag(sb, restored.uid);
      if (!cancelled) setServerAdmin(flag);
      if (!cancelled && restored.user) await refreshMemberships(sb);
    })();

    return () => { cancelled = true; };
  }, []);

  // Shared tail of every provider sign-in: read the user back, flip the
  // server-side admin flag from the allowlist, and derive the new role.
  // nameHint covers Apple, which sends the full name ONLY on first sign-in
  // and never puts it in the identity token.
  const completeSignIn = async (
    sb: NonNullable<ReturnType<typeof getSupabase>>,
    nameHint?: string | null,
  ): Promise<Role | null> => {
    const got = await withTimeout(sb.auth.getUser(), 6000, { data: { user: null }, error: null } as any, 'getUser');
    const u = got?.data?.user;
    if (!u) { setError('signin', 'Signed in, but the session could not be read. Try again.'); return null; }

    let authUser = toAuthUser(u);
    if (authUser && nameHint && authUser.name === authUser.email) {
      authUser = { ...authUser, name: nameHint };
    }
    setUser(authUser);
    setUserId(u.id);

    // Server-side: flip profiles.is_admin from the allowlist so RLS lets
    // admin writes through. Client-side gating works even if this call is slow.
    await withTimeout(sb.rpc('sync_admin_role'), 6000, { data: null, error: null } as any, 'sync_admin_role');
    const flag = await readAdminFlag(sb, u.id);
    setServerAdmin(flag);
    await refreshMemberships(sb);

    return deriveRole({ synced: true, user: authUser, serverAdmin: flag, localUnlocked });
  };

  // ---- Google Sign-In (Supabase OAuth + PKCE via the system browser) -------
  const signInWithGoogle = async (): Promise<Role | null> => {
    setError('signin', null);

    if (!SYNC_ENABLED) {
      setError('signin', 'Google sign-in needs the Supabase sync configuration. This build is running local-only.');
      return null;
    }
    const sb = getSupabase();
    if (!sb) { setError('signin', 'Sync not configured.'); return null; }

    setAuthBusy(true);
    try {
      // Deep link back into the app. Expo Go → exp://.../--/auth-callback,
      // dev/prod builds → itala://auth-callback (scheme from app.json).
      const { redirectTo, inExpoGo } = oauthRedirect();
      devLog('[auth] OAuth redirect URL (add to Supabase → Auth → URL Configuration):', redirectTo);
      if (inExpoGo) {
        devLog('[auth] Running in Expo Go. Unless the URL above is on the Supabase',
               'redirect allowlist, the provider will send the browser to the project',
               'Site URL instead — a scheme Expo Go cannot open, which Safari reports',
               'as "the address is invalid".');
      }

      const start = await withTimeout(
        sb.auth.signInWithOAuth({
          provider: 'google',
          options: { redirectTo, skipBrowserRedirect: true },
        }),
        8000,
        { data: { url: null }, error: { message: 'timeout' } } as any,
        'signInWithOAuth'
      );
      if (start?.error || !start?.data?.url) {
        warn('[auth] could not start Google sign-in -', diagnoseAuthFailure(start?.error?.message, 'Google'));
        setError('signin', describeAuthFailure(start?.error?.message, 'Google'));
        return null;
      }

      // Never hand the browser something that is not an absolute https URL.
      // "Safari cannot open the page because the address is invalid" is what
      // iOS shows when it is, and it reads to the user like a broken app rather
      // than a failed request.
      if (!/^https?:\/\//i.test(start.data.url)) {
        warn('[auth] the provider returned a URL the browser cannot open:', start.data.url);
        setError('signin', "Sign-in couldn't start. Please try again.");
        return null;
      }

      // Opens the system browser; resolves when the browser redirects back.
      const result = await WebBrowser.openAuthSessionAsync(start.data.url, redirectTo);
      if (result.type !== 'success' || !('url' in result) || !result.url) {
        // The sheet closed without ever reaching our redirect. Two causes, and
        // they used to be treated the same — silently, as "user cancelled":
        //
        //   * the person tapped Cancel, which is not an error, or
        //   * the provider sent the browser somewhere this build cannot
        //     receive, so the sheet had nothing to intercept and the person
        //     tapped Cancel on an error page.
        //
        // iOS gives no way to tell them apart after the fact, so say nothing
        // in a build whose scheme is registered (where only the first is
        // plausible) and name the second where it is the likely one.
        devLog('[auth] the browser closed without reaching', redirectTo,
               '- either the person cancelled, or the provider sent it somewhere',
               'this build cannot receive.', allowlistHint(redirectTo));
        // Deliberately silent. The common case by far is "they tapped Cancel",
        // and iOS gives no way to tell that apart after the fact - so an error
        // here would accuse most people of a failure they did not have.
        return null;
      }

      const created = await createSessionFromUrl(sb, result.url);
      if (!created.ok) {
        warn('[auth] sign-in did not complete -', diagnoseAuthFailure(created.reason, 'Google'));
        devLog('[auth] redirect in use:', redirectTo, '-', allowlistHint(redirectTo));
        setError('signin', describeAuthFailure(created.reason, 'Google'));
        return null;
      }

      return await completeSignIn(sb);
    } catch (e) {
      warn('[auth] signInWithGoogle threw -', diagnoseAuthFailure((e as Error).message, 'Google'));
      setError('signin', describeAuthFailure((e as Error).message, 'Google'));
      return null;
    } finally {
      setAuthBusy(false);
    }
  };

  // ---- Sign in with Apple (native sheet → Supabase ID-token exchange) ------
  const signInWithApple = async (): Promise<Role | null> => {
    setError('signin', null);
    if (!SYNC_ENABLED) {
      setError('signin', 'Apple sign-in needs the Supabase sync configuration. This build is running local-only.');
      return null;
    }
    const sb = getSupabase();
    if (!sb) { setError('signin', 'Sync not configured.'); return null; }

    // Apple signs the identity token for the bundle id of the app that asked,
    // so inside Expo Go the audience is host.exp.Exponent rather than
    // com.bpbl.itala and Supabase rejects it — unless the provider's Client IDs
    // list includes host.exp.Exponent, which AUTH_SETUP.md tells you to do for
    // development. So this is a hint, not a block: the flow is allowed to run
    // and describeAuthFailure explains an audience rejection if one comes back.
    if (oauthRedirect().inExpoGo) {
      devLog('[auth] Apple sign-in from Expo Go: the token audience will be',
             'host.exp.Exponent, not com.bpbl.itala. Supabase → Providers → Apple →',
             'Client IDs must list it for development (remove before shipping).');
    }

    setAuthBusy(true);
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!credential.identityToken) {
        setError('signin', 'Apple did not return a sign-in token. Try again.');
        return null;
      }

      const res = await withTimeout(
        sb.auth.signInWithIdToken({ provider: 'apple', token: credential.identityToken }),
        8000,
        { data: { session: null }, error: { message: 'timeout' } } as any,
        'signInWithIdToken(apple)'
      );
      if (res?.error) {
        warn('[auth] Apple sign-in rejected -', diagnoseAuthFailure(res.error.message, 'Apple'));
        setError('signin', describeAuthFailure(res.error.message, 'Apple'));
        return null;
      }

      // Apple provides the name only on the very FIRST authorization.
      const fn = credential.fullName;
      const nameHint = fn ? [fn.givenName, fn.familyName].filter(Boolean).join(' ') || null : null;
      return await completeSignIn(sb, nameHint);
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === 'ERR_REQUEST_CANCELED') return null; // user closed the sheet
      warn('[auth] signInWithApple threw -', diagnoseAuthFailure((e as Error).message, 'Apple'));
      setError('signin', describeAuthFailure((e as Error).message, 'Apple'));
      return null;
    } finally {
      setAuthBusy(false);
    }
  };

  // ---- Account deletion (store-policy requirement) --------------------------
  const deleteAccount = async (): Promise<boolean> => {
    setError('account', null);
    if (!SYNC_ENABLED) { setError('account', 'There is no account to delete in local-only mode.'); return false; }
    const sb = getSupabase();
    if (!sb) { setError('account', 'Sync not configured.'); return false; }

    setAuthBusy(true);
    try {
      const res = await withTimeout(
        sb.rpc('delete_own_account'),
        8000,
        { data: null, error: { message: 'timeout' } } as { data: unknown; error: { message: string } | null },
        'delete_own_account'
      );
      if (res?.error) {
        warn('[auth] delete_own_account failed -', diagnoseAuthFailure(res.error.message));
        setError('account', describeAuthFailure(res.error.message));
        return false;
      }

      // The server-side user is gone; clear the (now-orphaned) local session
      // and return to a fresh guest session. scope 'local' avoids a doomed
      // round-trip to the logout endpoint for a user that no longer exists.
      await withTimeout(sb.auth.signOut({ scope: 'local' }), 6000, { error: null } as any, 'signOut(local)');
      setUser(null);
      setServerAdmin(false);
      setMemberships({});
      const restored = await ensureSession(sb);
      setUserId(restored?.uid ?? null);
      return true;
    } finally {
      setAuthBusy(false);
    }
  };

  const signOut = async (): Promise<void> => {
    clearError();
    if (!SYNC_ENABLED) { setLocalUnlocked(false); return; }
    const sb = getSupabase();
    if (!sb) return;
    setAuthBusy(true);
    try {
      await withTimeout(sb.auth.signOut(), 6000, { error: null } as any, 'signOut');
      setUser(null);
      setServerAdmin(false);
      setMemberships({});
      // Return to a guest (anonymous) session so reads + realtime keep working.
      const restored = await ensureSession(sb);
      setUserId(restored?.uid ?? null);
    } finally {
      setAuthBusy(false);
    }
  };

  // ---- Per-league permissions ------------------------------------------------
  // ONE place answers "what can this person do in this league". Screens call
  // these with the league object; nothing else checks memberships directly.
  const canScore = (l: { id: string; kind?: string; isShared?: boolean }): boolean => {
    if (!SYNC_ENABLED) return role === 'admin' || role === 'user'; // local device is trusted
    if (role === 'admin') return true;                              // Super Admin
    if (memberships[l.id]) return true;                             // owner or scorekeeper
    if (l.kind === 'recreational' && l.isShared) return !!user;     // shared rec: any signed-in user
    return false;
  };
  // Scoring rights for ONE game. A community drop-in game belongs to whoever
  // started it; everywhere else the league rules apply. Mirrors can_score_game
  // in schema.sql — keep the two in step.
  const canScoreGame = (
    l: { id: string; kind?: string; isShared?: boolean },
    g?: { createdBy?: string },
  ): boolean => {
    if (role === 'admin') return true;
    if (l.kind === 'recreational' && l.isShared) return !!g?.createdBy && g.createdBy === userId;
    return canScore(l);
  };

  const isOwner = (l: { id: string; kind?: string; isShared?: boolean }): boolean => {
    if (!SYNC_ENABLED) return role === 'admin';
    if (role === 'admin') return true;
    return memberships[l.id] === 'owner';
  };

  const redeemCode: AdminCtx['redeemCode'] = async (code) => {
    setError('code', null);
    const sb = getSupabase();
    if (!SYNC_ENABLED || !sb) return { type: 'error', message: 'Invite codes need the synced (Supabase) setup.' };
    if (!user) return { type: 'error', message: 'Sign in first to use an invite code.' };
    setAuthBusy(true);
    try {
      const res = await withTimeout(sb.rpc('redeem_code', { p_code: code }), 8000,
        { data: null, error: { message: 'timeout' } } as any, 'redeem_code');
      if (res?.error) {
        return { type: 'error', message: res.error.message === 'timeout' ? 'Server did not respond. Try again.' : res.error.message };
      }
      const d = res?.data as { type: string; league_id?: string; role?: 'owner' | 'scorekeeper'; league_name?: string };
      if (d?.type === 'create') return { type: 'create' };
      if (d?.type === 'joined' && d.league_id && d.role) {
        await refreshMemberships(sb);
        return { type: 'joined', leagueId: d.league_id, role: d.role, leagueName: d.league_name ?? 'the league' };
      }
      return { type: 'error', message: 'Invalid code.' };
    } finally {
      setAuthBusy(false);
    }
  };

  const createCreationCode = async (): Promise<string | null> => {
    const sb = getSupabase();
    if (!sb) return null;
    const res = await withTimeout(sb.rpc('create_creation_code'), 8000, { data: null, error: { message: 'timeout' } } as any, 'create_creation_code');
    if (res?.error) {
      warn('[auth] create_creation_code failed -', diagnoseAuthFailure(res.error.message));
      setError('admin', isNetworkFailure(res.error.message)
        ? describeAuthFailure(res.error.message)
        : res.error.message);
      return null;
    }
    return typeof res?.data === 'string' ? res.data : null;
  };

  const getLeagueCodes = async (leagueId: string) => {
    const sb = getSupabase();
    if (!sb) return null;
    const res = await withTimeout(sb.rpc('get_league_codes', { p_league_id: leagueId }), 8000, { data: null, error: null } as any, 'get_league_codes');
    const d = res?.data as { owner?: string; scorekeeper?: string } | null;
    return d?.owner && d?.scorekeeper ? { owner: d.owner, scorekeeper: d.scorekeeper } : null;
  };

  const regenerateLeagueCode = async (leagueId: string, roleArg: 'owner' | 'scorekeeper') => {
    const sb = getSupabase();
    if (!sb) return null;
    const res = await withTimeout(sb.rpc('regenerate_league_code', { p_league_id: leagueId, p_role: roleArg }), 8000, { data: null, error: null } as any, 'regenerate_league_code');
    return typeof res?.data === 'string' ? res.data : null;
  };

  const listMembers = async (leagueId: string) => {
    const sb = getSupabase();
    if (!sb) return null;
    const res = await withTimeout(sb.rpc('list_members', { p_league_id: leagueId }), 8000, { data: null, error: null } as any, 'list_members');
    return Array.isArray(res?.data) ? res.data as { user_id: string; role: string; name: string; email: string | null }[] : null;
  };

  const removeMember = async (leagueId: string, userId: string) => {
    const sb = getSupabase();
    if (!sb) return false;
    const res = await withTimeout(sb.rpc('remove_member', { p_league_id: leagueId, p_user_id: userId }), 8000, { data: null, error: { message: 'timeout' } } as any, 'remove_member');
    if (res?.error) {
      warn('[auth] remove_member failed -', diagnoseAuthFailure(res.error.message));
      setError('admin', isNetworkFailure(res.error.message)
        ? describeAuthFailure(res.error.message)
        : res.error.message);
      return false;
    }
    return true;
  };

  // ---- Password backup (hidden lock) ---------------------------------------
  const unlock = async (password: string): Promise<boolean> => {
    setError('admin', null);

    // Local-only mode: no server, so this is a device-local check. Fails closed
    // when no fallback password is configured.
    if (!SYNC_ENABLED) {
      if (!LOCAL_FALLBACK_PASSWORD) {
        setError('admin', 'No local admin password is configured for this build.');
        return false;
      }
      const ok = slowEquals(password, LOCAL_FALLBACK_PASSWORD);
      if (ok) setLocalUnlocked(true);
      else setError('admin', 'Incorrect password.');
      return ok;
    }

    const sb = getSupabase();
    if (!sb) { setError('admin', 'Sync not configured.'); return false; }

    const restored = await ensureSession(sb);
    if (!restored?.uid) {
      setError('admin', "Couldn't reach iTala, so the password couldn't be checked. Check your internet connection and try again.");
      return false;
    }
    setUserId(restored.uid);

    const res = await withTimeout(
      sb.rpc('elevate_to_admin', { password_attempt: password }),
      8000,
      { data: null, error: { message: 'timeout' } } as { data: unknown; error: { message: string } | null },
      'elevate_to_admin'
    );

    if (res.error) {
      const msg = res.error.message ?? '';
      warn('[auth] elevate_to_admin error:', msg);
      if (/too many attempts/i.test(msg)) {
        // The server locks a session out after a handful of wrong guesses and
        // raises rather than returning false. Show its message verbatim — it
        // carries the remaining wait.
        setError('admin', msg);
      } else {
        warn('[auth] elevate_to_admin failed -', diagnoseAuthFailure(msg));
        setError('admin', isNetworkFailure(msg) ? describeAuthFailure(msg) : msg);
      }
      return false;
    }

    const ok = !!res.data;
    if (ok) setServerAdmin(true);
    else setError('admin', 'Incorrect password.');
    return ok;
  };

  const lock = async (): Promise<void> => {
    setError('admin', null);
    if (!SYNC_ENABLED) { setLocalUnlocked(false); return; }
    const sb = getSupabase();
    if (sb) {
      await withTimeout(sb.rpc('lock_admin'), 5000, { data: null, error: null } as any, 'lock_admin');
    }
    setServerAdmin(false);
  };

  return (
    <Ctx.Provider value={{
      role, isAdmin: role === 'admin', user, userId, authBusy, errorFor, clearError,
      memberships, canScore, canScoreGame, isOwner, reloadMemberships, redeemCode, createCreationCode,
      getLeagueCodes, regenerateLeagueCode, listMembers, removeMember,
      signInWithGoogle, appleAvailable, signInWithApple, deleteAccount, signOut, unlock, lock,
    }}>
      {children}
    </Ctx.Provider>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toAuthUser(u: { id: string; email?: string | null; is_anonymous?: boolean; user_metadata?: Record<string, any> }): AuthUser | null {
  if (!u || u.is_anonymous || !u.email) return null;
  const md = u.user_metadata ?? {};
  return {
    id: u.id,
    email: u.email,
    name: md.full_name || md.name || u.email,
    avatarUrl: md.avatar_url || md.picture || null,
  };
}

/** Turns the OAuth redirect URL back into a Supabase session.
 *  Handles both PKCE (?code=) and implicit (#access_token=) responses. */
interface SessionFromUrl {
  ok: boolean;
  /** Raw reason, for the log and for classifying the user-facing message.
   *  Never shown verbatim. */
  reason?: string;
}

async function createSessionFromUrl(
  sb: NonNullable<ReturnType<typeof getSupabase>>,
  url: string,
): Promise<SessionFromUrl> {
  try {
    const parsed = Linking.parse(url);
    const qp = (parsed.queryParams ?? {}) as Record<string, string | string[]>;

    // The provider itself refused (consent declined, misconfigured client,
    // redirect the provider would not accept). Its own words are the only
    // useful diagnostic here.
    const errDesc = str(qp['error_description']) ?? str(qp['error']);
    if (errDesc) return { ok: false, reason: `provider returned: ${errDesc}` };

    const code = str(qp['code']);
    if (code) {
      const res = await withTimeout(sb.auth.exchangeCodeForSession(code), 15000,
        { data: { session: null }, error: { message: 'timeout' } } as any, 'exchangeCodeForSession');
      if (res?.error) return { ok: false, reason: `exchangeCodeForSession: ${res.error.message}` };
      if (!res?.data?.session) return { ok: false, reason: 'exchangeCodeForSession returned no session' };
      return { ok: true };
    }

    // Implicit flow: tokens arrive in the URL fragment.
    const frag = url.split('#')[1];
    if (frag) {
      const p = new URLSearchParams(frag);
      const access_token = p.get('access_token');
      const refresh_token = p.get('refresh_token');
      if (access_token && refresh_token) {
        const res = await withTimeout(sb.auth.setSession({ access_token, refresh_token }), 15000,
          { data: { session: null }, error: { message: 'timeout' } } as any, 'setSession');
        if (res?.error) return { ok: false, reason: `setSession: ${res.error.message}` };
        if (!res?.data?.session) return { ok: false, reason: 'setSession returned no session' };
        return { ok: true };
      }
    }

    // Came back, but with neither a code nor tokens. Worth naming the keys that
    // DID arrive - this is the case that is impossible to guess at from a log
    // line saying only that sign-in did not complete.
    return { ok: false, reason: `callback carried no code and no tokens (params: ${Object.keys(qp).join(', ') || 'none'})` };
  } catch (e) {
    return { ok: false, reason: `threw: ${(e as Error).message}` };
  }
}

function str(v: string | string[] | undefined): string | null {
  if (!v) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

// Returns the current session (restoring Google or creating anonymous).
// Always resolves within a few seconds (timeout-guarded); null on failure.
async function ensureSession(sb: ReturnType<typeof getSupabase>): Promise<{ uid: string; user: AuthUser | null } | null> {
  if (!sb) return null;
  try {
    // raceTimeout, not withTimeout, because the two outcomes must be told
    // apart. supabase-js resolves getSession() only after its own
    // initialisation promise, and that initialisation REFRESHES an expired
    // access token — a network call. On a device that cannot reach the server
    // (the reported logs: "getSession timed out after 5000ms" on every launch,
    // then TypeError: Network request failed for everything after it) the call
    // does not answer. A fallback of `{ session: null }` makes that
    // indistinguishable from "this device is signed out", and the recovery path
    // below then DELETES the stored tokens and mints a brand new anonymous
    // user. So a bad connection silently signed people out and handed their
    // drop-in games to a different uid. A timeout is not an answer, and must
    // never be treated as one.
    const sess = await raceTimeout(sb.auth.getSession(), 5000, 'getSession');
    const existing = sess.ok ? sess.value?.data?.session?.user : undefined;
    const plan = sessionRecoveryPlan(
      sess.ok ? { answered: true, hasSession: !!existing?.id } : { answered: false },
    );

    if (plan === 'leave-alone') {
      warn('[auth] getSession did not answer — leaving the stored session untouched');
      return null;
    }
    if (plan === 'use-existing' && existing?.id) {
      return { uid: existing.id, user: toAuthUser(existing) };
    }

    // getSession ANSWERED, and the answer is "no session". Two ways to get
    // here: a genuinely fresh install, or a stale session whose refresh token
    // was rotated, revoked, or belongs to another project — which keeps
    // poisoning every auth call and repeats on EVERY launch ("Invalid Refresh
    // Token: Refresh Token Not Found"). Clearing the stored tokens locally (no
    // network round trip) heals the second and is a no-op for the first. It is
    // only safe because the answer was real: there is nothing here to lose.
    await withTimeout(
      sb.auth.signOut({ scope: 'local' }),
      3000,
      { error: null } as any,
      'signOut(purge-stale)',
    );

    const signin = await raceTimeout(sb.auth.signInAnonymously(), 6000, 'signInAnonymously');
    if (!signin.ok) return null;
    if (signin.value?.error) {
      warn('[auth] anonymous sign-in failed:', signin.value.error.message, '— is Anonymous sign-in enabled in Supabase → Authentication → Providers?');
      return null;
    }
    const uid = signin.value?.data?.user?.id ?? signin.value?.data?.session?.user?.id ?? null;
    return uid ? { uid, user: null } : null;
  } catch (e) {
    warn('[auth] ensureSession threw:', (e as Error).message);
    return null;
  }
}

async function readAdminFlag(sb: ReturnType<typeof getSupabase>, uid: string): Promise<boolean> {
  if (!sb) return false;
  try {
    const res = await withTimeout(
      sb.from('profiles').select('is_admin').eq('id', uid).maybeSingle(),
      5000,
      { data: null, error: null } as any,
      'readAdminFlag'
    );
    return !!res?.data?.is_admin;
  } catch {
    return false;
  }
}

export function useAdmin(): AdminCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAdmin must be used within AdminProvider');
  return c;
}
