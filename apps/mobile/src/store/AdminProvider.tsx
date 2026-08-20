/**
 * Admin state: whether THIS DEVICE may write.
 *
 * Deliberately isolated from the data store, as it was in v1, because it is a
 * different concern with a different failure mode. Kept from v1 verbatim:
 * every Supabase call in here is timeout-guarded, because a hung await used to
 * freeze the unlock flow with no way out.
 *
 * What changed: the password is checked against a bcrypt hash server-side with
 * a lockout, the RPC returns a reason rather than a bare boolean so the copy
 * can be honest, and the hardcoded fallback password is gone.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { SYNC_ENABLED, TIMEOUTS, getSupabase, withTimeout } from '../sync/client';

export type UnlockResult = { ok: true } | { ok: false; message: string };

interface AdminValue {
  isAdmin: boolean;
  busy: boolean;
  /** The anonymous user id, truncated, for the settings screen. */
  deviceId: string | null;
  unlock(password: string): Promise<UnlockResult>;
  lock(): Promise<void>;
}

const AdminContext = createContext<AdminValue | null>(null);

interface ElevateResponse {
  ok?: boolean;
  reason?: string;
  attempts_remaining?: number;
  retry_after_seconds?: number;
}

/** User-facing copy. Every message says what to check or what to do next. */
function messageFor(r: ElevateResponse): string {
  switch (r.reason) {
    case 'wrong_password': {
      const left = r.attempts_remaining;
      return typeof left === 'number'
        ? `Incorrect password. ${left} ${left === 1 ? 'try' : 'tries'} left before this device is locked out.`
        : 'Incorrect password.';
    }
    case 'locked': {
      const secs = r.retry_after_seconds ?? 0;
      const mins = Math.max(1, Math.ceil(secs / 60));
      return `Too many attempts. Try again in about ${mins} minute${mins === 1 ? '' : 's'}.`;
    }
    case 'no_session':
      return 'Could not reach the server. Check your connection and that Anonymous sign-in is enabled in Supabase.';
    case 'not_configured':
      return 'No admin password has been set on this project yet. See supabase/README.md.';
    default:
      return 'Could not unlock. Check your connection and try again.';
  }
}

async function ensureSession(): Promise<Session | null> {
  const sb = getSupabase();
  if (!sb) return null;

  const existing = await withTimeout(sb.auth.getSession(), TIMEOUTS.getSession, null, 'getSession');
  if (existing?.data.session) return existing.data.session;

  const created = await withTimeout(
    sb.auth.signInAnonymously(),
    TIMEOUTS.signIn,
    null,
    'signInAnonymously',
  );
  if (!created || created.error) {
    if (created?.error) {
      console.warn(
        `[itala] anonymous sign-in failed: ${created.error.message} - is Anonymous sign-in enabled in Supabase, Authentication, Providers?`,
      );
    }
    return null;
  }
  return created.data.session;
}

export function AdminProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);

  // Read the flag back at boot. Admin survives a restart because the anonymous
  // session is persisted, so the same profile row is found again.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!SYNC_ENABLED) return;
      const session = await ensureSession();
      if (cancelled || !session) return;
      setDeviceId(session.user.id);

      const sb = getSupabase();
      if (!sb) return;
      const res = await withTimeout(
        sb.from('profiles').select('is_admin').eq('id', session.user.id).maybeSingle(),
        TIMEOUTS.readProfile,
        null,
        'readAdminFlag',
      );
      if (cancelled) return;
      setIsAdmin(Boolean(res?.data?.is_admin));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const unlock = useCallback(async (password: string): Promise<UnlockResult> => {
    if (!SYNC_ENABLED) {
      return { ok: false, message: 'Sync is not configured on this build.' };
    }
    setBusy(true);
    try {
      const session = await ensureSession();
      if (!session) return { ok: false, message: messageFor({ reason: 'no_session' }) };
      setDeviceId(session.user.id);

      const sb = getSupabase();
      if (!sb) return { ok: false, message: messageFor({}) };

      const res = await withTimeout(
        sb.rpc('elevate_to_admin', { password_attempt: password }),
        TIMEOUTS.elevate,
        null,
        'elevate_to_admin',
      );
      if (!res || res.error) {
        if (res?.error) console.warn('[itala] elevate_to_admin error:', res.error.message);
        return { ok: false, message: 'Server did not respond. Check your connection.' };
      }

      const payload = (res.data ?? {}) as ElevateResponse;
      if (payload.ok) {
        setIsAdmin(true);
        return { ok: true };
      }
      return { ok: false, message: messageFor(payload) };
    } finally {
      setBusy(false);
    }
  }, []);

  const lock = useCallback(async () => {
    // Local state drops regardless of whether the RPC succeeded, so the UI
    // always locks even offline. The server flag may lag until the next
    // successful call, which is the safe direction to be wrong in.
    setIsAdmin(false);
    const sb = getSupabase();
    if (!sb) return;
    await withTimeout(sb.rpc('lock_admin'), TIMEOUTS.lock, null, 'lock_admin');
  }, []);

  const value = useMemo<AdminValue>(
    () => ({ isAdmin, busy, deviceId, unlock, lock }),
    [isAdmin, busy, deviceId, unlock, lock],
  );

  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>;
}

export function useAdmin(): AdminValue {
  const v = useContext(AdminContext);
  if (!v) throw new Error('useAdmin must be used inside AdminProvider');
  return v;
}
