import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SupabaseClient } from '@supabase/supabase-js';

// One release identifies the exact set of three documents, not the app version.
export const LEGAL_VERSION = '2026-09-04';
export const LEGAL_LINKS = [
  { label: 'Terms of Use', url: 'https://www.itala.fyi/terms/' },
  { label: 'Privacy Policy', url: 'https://www.itala.fyi/privacy/' },
  { label: 'Content Policy', url: 'https://www.itala.fyi/content-policy/' },
] as const;
export const LEGAL_STATEMENT = 'I agree to the Terms of Use and Content Policy and acknowledge the Privacy Policy.';
export interface LegalStatus { version: string; accepted_at: string | null }
export class LegalVersionError extends Error {}
const cacheKey = (uid: string) => `itala.legal.receipt.v1.${uid}`;

async function deadline<T>(promise: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Legal request timed out.')), 8000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

function parseStatus(data: unknown): LegalStatus {
  if (!data || typeof data !== 'object') throw new Error('Legal information is unavailable.');
  const value = data as Partial<LegalStatus>;
  if (typeof value.version !== 'string' || !value.version ||
      (value.accepted_at !== null && (typeof value.accepted_at !== 'string' || !Number.isFinite(Date.parse(value.accepted_at))))) {
    throw new Error('Legal information is unavailable.');
  }
  return { version: value.version, accepted_at: value.accepted_at };
}

export async function readLegalStatus(sb: SupabaseClient): Promise<LegalStatus> {
  const res = await deadline(sb.rpc('legal_status'));
  if (res.error) throw new Error('Could not load the legal documents. Check your connection and try again.');
  const status = parseStatus(res.data);
  if (status.version !== LEGAL_VERSION) throw new LegalVersionError('Please update iTala to review the latest legal documents.');
  return status;
}

export async function recordLegalAcceptance(sb: SupabaseClient, version: string): Promise<LegalStatus> {
  const res = await deadline(sb.rpc('accept_legal', { p_version: version }));
  if (res.error) throw new Error('Could not save your acknowledgement. Check your connection and try again.');
  const status = parseStatus(res.data);
  if (status.version !== version || !status.accepted_at) throw new Error('Your acknowledgement was not confirmed. Please try again.');
  return status;
}

export async function cachedLegalReceipt(uid: string): Promise<LegalStatus | null> {
  try {
    const raw = await deadline(AsyncStorage.getItem(cacheKey(uid)));
    if (!raw) return null;
    const receipt = parseStatus(JSON.parse(raw));
    return receipt.version === LEGAL_VERSION && receipt.accepted_at ? receipt : null;
  } catch { return null; } // A cache is optional; a miss must go to the server.
}

export async function cacheLegalReceipt(uid: string, receipt: LegalStatus): Promise<void> {
  if (!receipt.accepted_at || receipt.version !== LEGAL_VERSION) return;
  // The server receipt is authoritative. A cache failure must not undo it.
  try { await deadline(AsyncStorage.setItem(cacheKey(uid), JSON.stringify(receipt))); }
  catch { /* Offline startup will require a fresh server check. */ }
}

export async function forgetLegalReceipt(uid: string): Promise<void> {
  await deadline(AsyncStorage.removeItem(cacheKey(uid)));
}
