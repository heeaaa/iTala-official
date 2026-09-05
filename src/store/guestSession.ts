import type { SupabaseClient } from '@supabase/supabase-js';

type GuestResult = Awaited<ReturnType<SupabaseClient['auth']['signInAnonymously']>>;
const pending = new WeakMap<SupabaseClient, Promise<GuestResult>>();

// Startup and report recovery share the same operation. Keep it registered
// until the underlying request settles, even if a caller stops waiting.
export function ensureGuestSession(sb: SupabaseClient): Promise<GuestResult> {
  const existing = pending.get(sb);
  if (existing) return existing;
  const request = Promise.resolve().then(async (): Promise<GuestResult> => {
    // Recheck before creating a guest: an account may have signed in meanwhile.
    // An error or stalled read is never permission to replace stored credentials.
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    if (data.session) return { data: { session: data.session, user: data.session.user }, error: null };
    return sb.auth.signInAnonymously();
  }).finally(() => { pending.delete(sb); });
  pending.set(sb, request);
  return request;
}
