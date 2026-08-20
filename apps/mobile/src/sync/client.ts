/**
 * The Supabase client, and the build-time switch that decides whether this
 * install syncs at all.
 *
 * The anon key is PUBLIC by design. It ships inside the binary and row-level
 * security is what protects writes, not key secrecy. See docs/DEPLOYMENT.md.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

/** Both are required together. With either missing the app is local-only. */
export const SYNC_ENABLED = Boolean(URL && ANON);

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!SYNC_ENABLED) return null;
  if (!client) {
    client = createClient(URL, ANON, {
      auth: {
        storage: AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        // Correct for a native app: there is no URL to read a session from.
        detectSessionInUrl: false,
      },
      realtime: {
        // Throttle so a burst of stats does not hammer the channel.
        params: { eventsPerSecond: 10 },
      },
    });
  }
  return client;
}

/**
 * HARD RULE IN THIS CODEBASE: no Supabase call is ever awaited without a
 * timeout.
 *
 * supabase-js auth methods can hang in React Native when storage or locks
 * stall, and a hung await silently freezes whatever flow is waiting on it.
 * That was a real production bug in v1. Every call races a timeout and always
 * produces a definite result.
 */
export function withTimeout<T>(
  promise: PromiseLike<T>,
  ms: number,
  fallback: T,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.warn(`[itala] ${label} timed out after ${ms}ms`);
      resolve(fallback);
    }, ms);

    Promise.resolve(promise).then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        console.warn(`[itala] ${label} threw:`, err);
        resolve(fallback);
      },
    );
  });
}

export const TIMEOUTS = {
  getSession: 5_000,
  signIn: 6_000,
  elevate: 8_000,
  lock: 5_000,
  readProfile: 5_000,
  push: 15_000,
  pull: 20_000,
} as const;
