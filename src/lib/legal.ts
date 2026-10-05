import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SupabaseClient } from '@supabase/supabase-js';

// One release identifies the exact set of three documents, not the app version.
export const LEGAL_VERSION = '2026-10-02';
export const LEGAL_LINKS = [
  { label: 'Terms of Use', url: 'https://www.itala.fyi/terms/' },
  { label: 'Privacy Policy', url: 'https://www.itala.fyi/privacy/' },
  { label: 'Content Policy', url: 'https://www.itala.fyi/content-policy/' },
] as const;
export const PRIVACY_POLICY_URL = LEGAL_LINKS[1].url;
// The bundle before LEGAL_VERSION. A build ships while the server still requires
// it - docs/LEGAL_ACKNOWLEDGEMENT.md promotes the new bundle only once the build
// is available - so for that window the build shows and records this bundle
// instead of signing every account out. Its links are the immutable archive
// copies its receipts cite, never the canonical pages, which change at promotion.
export const PREVIOUS_LEGAL_VERSION = '2026-09-07';
const PREVIOUS_LEGAL_LINKS = [
  { label: 'Terms of Use', url: 'https://www.itala.fyi/archive/2026-09-07/terms/' },
  { label: 'Privacy Policy', url: 'https://www.itala.fyi/archive/2026-09-07/privacy/' },
  { label: 'Content Policy', url: 'https://www.itala.fyi/archive/2026-09-07/content-policy/' },
] as const;
export interface LegalLink { readonly label: string; readonly url: string }
// A Map, not an object literal: a server version such as "constructor" must not
// find an inherited property and pass as a bundle this build can show.
const LEGAL_BUNDLES: ReadonlyMap<string, readonly LegalLink[]> = new Map<string, readonly LegalLink[]>([
  [LEGAL_VERSION, LEGAL_LINKS],
  [PREVIOUS_LEGAL_VERSION, PREVIOUS_LEGAL_LINKS],
]);
const isKnownVersion = (version: string) => LEGAL_BUNDLES.has(version);
// The documents behind `version`. Prompts only ever carry a known version.
export const legalLinksFor = (version: string): readonly LegalLink[] => LEGAL_BUNDLES.get(version) ?? LEGAL_LINKS;
export const LEGAL_STATEMENT = 'I agree to the Terms of Use and Content Policy and acknowledge the Privacy Policy.';
export interface LegalStatus { version: string; accepted_at: string | null }
export class LegalVersionError extends Error {}
const cacheKey = (uid: string) => `itala.legal.receipt.v1.${uid}`;
// The version the server last required. It is the same for every account, so the
// device keeps it: once it is known, a cached receipt for any other version cannot
// reopen an account offline, even where that account's own cache survived (a failed
// delete, another account, a save abandoned part-way). Builds before this one never
// wrote it, so its absence keeps their receipts usable after an upgrade.
const requiredKey = 'itala.legal.required.v1';

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
  // Kept before the version check, so an unknown newer version retires every
  // cached receipt too.
  try { await deadline(AsyncStorage.setItem(requiredKey, status.version)); }
  catch { /* Each account's own cache is still cleared; this is the backstop. */ }
  // Any bundle other than this build's two is text it cannot identify.
  if (!isKnownVersion(status.version)) throw new LegalVersionError('Please update iTala to review the latest legal documents.');
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
    const required = await deadline(AsyncStorage.getItem(requiredKey));
    return isKnownVersion(receipt.version) && receipt.accepted_at && (!required || receipt.version === required)
      ? receipt : null;
  } catch { return null; } // A cache is optional; a miss must go to the server.
}

export async function cacheLegalReceipt(uid: string, receipt: LegalStatus): Promise<void> {
  if (!receipt.accepted_at || !isKnownVersion(receipt.version)) return;
  // The server receipt is authoritative. A cache failure must not undo it.
  try { await deadline(AsyncStorage.setItem(cacheKey(uid), JSON.stringify(receipt))); }
  catch { /* Offline startup will require a fresh server check. */ }
}

export async function forgetLegalReceipt(uid: string): Promise<void> {
  await deadline(AsyncStorage.removeItem(cacheKey(uid)));
}
