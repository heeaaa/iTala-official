import { getSupabase, SYNC_ENABLED } from '../sync/supabase';

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

function timeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  return Promise.race([
    Promise.resolve(promise),
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('The request timed out. Please try again.')), ms)),
  ]);
}

export async function submitContentReport(input: ContentReportInput): Promise<ContentReportReceipt> {
  if (!SYNC_ENABLED) throw new Error('Reporting is available in the synced App Store and Google Play build.');
  const sb = getSupabase();
  if (!sb) throw new Error('Reporting is temporarily unavailable.');

  const { data, error } = await timeout(sb.rpc('submit_content_report', {
    p_record_type: input.recordType,
    p_record_id: input.recordId,
    p_league_id: input.leagueId,
    p_team_id: input.teamId ?? null,
    p_reason: input.reason,
    p_explanation: input.explanation?.trim() || null,
    p_contact_email: input.contactEmail?.trim() || null,
  }), 10_000);

  if (error) throw new Error(error.message || 'The report could not be submitted.');
  const receipt = data as { reference?: string; submitted_at?: string } | null;
  if (!receipt?.reference || !receipt.submitted_at) throw new Error('The server did not return a report reference.');

  return { reference: receipt.reference, submittedAt: receipt.submitted_at };
}
