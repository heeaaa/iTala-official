import { getSupabase, SYNC_ENABLED } from '../sync/supabase';
import { isNetworkFailure } from '../store/authErrors';
import { ensureGuestSession } from '../store/guestSession';

export const REPORT_REASONS = [
  'Incorrect information',
  'Remove personal information',
  'I’m the player, parent or guardian',
  'Inappropriate or abusive content',
  'Unauthorized image',
  'Other privacy concern',
] as const;

export type ReportReason = typeof REPORT_REASONS[number];
export type ReportRecordType = 'player' | 'team' | 'game' | 'league';

export interface ContentReportInput {
  recordType: ReportRecordType;
  recordId: string;
  leagueId: string;
  teamId?: string;
  reason: ReportReason;
  explanation?: string;
  contactEmail?: string;
}

export interface ContentReportReceipt {
  reference: string;
  submittedAt: string;
}

// Observe AdminProvider's startup without creating a competing guest session.
function waitForSession(sb: NonNullable<ReturnType<typeof getSupabase>>): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    let subscription: { unsubscribe(): void } | undefined;
    const finish = (ready: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      subscription?.unsubscribe();
      if (ready) resolve();
      else reject(new Error('Your app is still connecting. Check your connection and try again.'));
    };
    const timer = setTimeout(() => finish(false), 12_000);
    subscription = sb.auth.onAuthStateChange((_event, session) => {
      if (session) finish(true);
    }).data.subscription;
    if (done) subscription.unsubscribe();
    void Promise.resolve().then(() => sb.auth.getSession()).then(async ({ data, error }) => {
      if (data.session) finish(true);
      else if (!error && !done) {
        const recovered = await ensureGuestSession(sb);
        if (recovered.data.session) finish(true);
      }
    }).catch(() => { /* Preserve the bounded wait and friendly failure message. */ });
  });
}

// Only app-owned copy may reach the form. Never return an arbitrary exception
// message: PostgREST, auth, native fetch and storage can all expose internals.
export function describeContentReportError(error: unknown): string {
  const raw = typeof error === 'object' && error !== null && 'message' in error
    ? String(error.message) : '';
  if (isNetworkFailure(raw) || /abort|timed? ?out|couldn’t confirm/i.test(raw)) {
    return 'We couldn’t confirm your report. Check your connection and tap Submit report to try again.';
  }
  switch (raw) {
    case 'Your app is still connecting. Check your connection and try again.':
    case 'An app session is required.':
      return 'Your app is still connecting. Check your connection and try again.';
    case 'Enter a valid contact email or leave it blank.':
      return 'Enter a valid contact email or leave it blank.';
    case 'Explanation is too long.':
      return 'Please shorten your explanation to 2,000 characters.';
    case 'Contact email is too long.':
      return 'Please enter an email address with no more than 254 characters.';
    case 'The reported record could not be found in that league.':
      return 'This information is no longer available. Go back and refresh the page before reporting it.';
    default:
      return 'We couldn’t submit your report. Please try again in a moment.';
  }
}

export async function submitContentReport(input: ContentReportInput, requestId: string): Promise<ContentReportReceipt> {
  if (!SYNC_ENABLED) throw new Error('Reporting is available in the synced App Store and Google Play build.');
  const sb = getSupabase();
  if (!sb) throw new Error('Reporting is temporarily unavailable.');

  await waitForSession(sb);
  // The server deduplicates requestId, including writes with a lost response.
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = sb.rpc('submit_content_report', {
        p_record_type: input.recordType,
        p_record_id: input.recordId,
        p_league_id: input.leagueId,
        p_team_id: input.teamId ?? null,
        p_reason: input.reason,
        p_explanation: input.explanation?.trim() || null,
        p_contact_email: input.contactEmail?.trim() || null,
        p_request_id: requestId,
      }).abortSignal(controller.signal);
      // Abort the transport and bound the wait even if native fetch ignores abort.
      const { data, error } = await Promise.race([
        Promise.resolve(request),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('The report request timed out.'));
          }, 10_000);
        }),
      ]);

      if (error) throw new Error(error.message || 'The report could not be submitted.');
      const receipt = data as { reference?: string; submitted_at?: string } | null;
      if (typeof receipt?.reference !== 'string' || !receipt.reference
        || typeof receipt.submitted_at !== 'string' || !receipt.submitted_at) {
        throw new Error('The server did not return a report reference.');
      }

      return { reference: receipt.reference, submittedAt: receipt.submitted_at };
    } catch (error) {
      if (!controller.signal.aborted && !isNetworkFailure((error as Error)?.message)) throw error;
      if (attempt === 2) throw new Error('We couldn’t confirm your report. Check your connection and tap Submit report to try again.');
    } finally {
      clearTimeout(timer);
    }
    await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
  }
  throw new Error('The report could not be submitted.');
}
