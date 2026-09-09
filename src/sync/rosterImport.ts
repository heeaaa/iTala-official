import { SupabaseClient } from '@supabase/supabase-js';
import { RosterDraft, saveRosterDraft } from '../store/rosterDraft';
import { enqueuePush } from './pushQueue';
import { createRosterTrace, networkCategory } from './rosterDiagnostics';

export type ImportResult = { saved: true } | { saved: false; message: string };
const active = new Map<string, { operation: string; result: Promise<ImportResult> }>();
const uncertain = 'We could not confirm whether the roster was saved. Your draft is kept on this device. Check your connection and retry.';

// A timeout is unknown, not evidence of rollback. Receipts make subsequent
// manual retries safe even if the timed-out transaction finishes later.
async function bounded<T>(request: PromiseLike<T>, controller?: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(request),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller?.abort(); reject(new Error('timeout')); }, 15000);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

// A preceding read may predate the save. Wait for it, then request a fresh read.
// Bound the complete refresh so a stalled shared read cannot trap this screen.
export async function refreshImportedRoster(read: () => Promise<boolean>): Promise<boolean> {
  try { return await bounded((async () => { await read(); return read(); })()); }
  catch { return false; }
}

function confirmed(data: unknown, draft: RosterDraft): boolean {
  const receipt = data as { import_id?: unknown; team_count?: unknown; player_count?: unknown } | null;
  const op = draft.operation!;
  return receipt?.import_id === op.id && receipt.team_count === op.teams.length &&
    receipt.player_count === op.teams.reduce((n, t) => n + t.players.length, 0);
}

export function submitRosterImport(sb: SupabaseClient, draft: RosterDraft): Promise<ImportResult> {
  const op = draft.operation;
  if (!op) return Promise.resolve({ saved: false, message: 'Review your roster before importing.' });
  const key = `${draft.actorId}:${draft.leagueId}`;
  const running = active.get(key);
  const operation = JSON.stringify(op);
  if (running) return running.operation === operation ? running.result
    : Promise.resolve({ saved: false, message: 'Another import is still running for this league. Resume that draft before trying again.' });
  const diagnostic = createRosterTrace();
  diagnostic.mark('START', { teams: op.teams.length, players: op.teams.reduce((n, t) => n + t.players.length, 0) });
  const run = (async (): Promise<ImportResult> => {
    try { await saveRosterDraft(draft); }
    catch { diagnostic.mark('STORAGE_FAILED'); return { saved: false, message: 'The draft could not be saved on this device. Free some storage and try again. Nothing was sent.' }; }
    diagnostic.mark('QUEUED');
    let expired = false;
    const queued = enqueuePush(async (): Promise<ImportResult> => {
      let stopNative = () => {};
      try {
        if (expired) return { saved: false, message: uncertain };
        diagnostic.mark('SESSION_START');
        stopNative = diagnostic.watchNative();
        const session = await bounded(sb.auth.getSession());
        if (expired) return { saved: false, message: uncertain };
        if (session.error || session.data.session?.user.id !== draft.actorId) {
          diagnostic.mark('SESSION_REFUSED');
          return { saved: false, message: 'Sign in with the account that started this import, then retry.' };
        }
        const args = { p_import_id: op.id, p_league_id: draft.leagueId, p_actor_id: draft.actorId };
        let problem: { code?: string; message?: string } | null = null;
        for (let request = 1; request <= 2; request++) {
          if (expired) return { saved: false, message: uncertain };
          if (request === 2) {
            const retrySession = await bounded(sb.auth.getSession());
            if (expired) return { saved: false, message: uncertain };
            if (retrySession.error || retrySession.data.session?.user.id !== draft.actorId) {
              diagnostic.mark('SESSION_REFUSED');
              return { saved: false, message: 'Sign in with the account that started this import, then retry.' };
            }
          }
          let transportFailure = false;
          try {
            const controller = new AbortController();
            diagnostic.mark('RPC_START', { request });
            const result = await bounded(sb.rpc('bulk_import_roster_once', { ...args, p_teams: op.teams }).abortSignal(controller.signal), controller);
            diagnostic.mark('RPC_RESULT', {
              status: typeof result.status === 'number' ? result.status : null,
              code: result.error?.code && /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(result.error.code) ? result.error.code : null,
              category: result.error ? networkCategory(result.error.message) : 'none',
              receiptConfirmed: !result.error && confirmed(result.data, draft),
            });
            if (!result.error && confirmed(result.data, draft)) return { saved: true };
            problem = result.error;
            transportFailure = result.status === 0 && !!result.error;
          } catch (error) {
            const category = networkCategory(error instanceof Error ? error.message : '');
            diagnostic.mark('RPC_THROW', { category });
            transportFailure = category === 'generic-network';
            // Keep the draft; manual retry uses the same immutable operation.
          }
          if (request === 1 && transportFailure && !expired) {
            diagnostic.mark('AUTO_RETRY');
            continue;
          }
          break;
        }
        if (problem?.code === 'P0001' || problem?.code === '42501' || problem?.code === '23505') {
          return { saved: false, message: 'The server did not accept this import. Your draft is kept. Refresh the league and check that it is empty and you still have access.' };
        }
        if (problem?.code === 'PGRST202') {
          return { saved: false, message: 'Roster importing needs a server update. Your draft is kept. Contact the app administrator before retrying.' };
        }
        return { saved: false, message: uncertain };
      } catch { diagnostic.mark('SESSION_FAILED_OR_TIMED_OUT'); return { saved: false, message: uncertain }; }
      finally { stopNative(); }
    });
    // Bound time spent behind older writes too. If this expires before our
    // callback starts, it must not send a surprise write when the queue clears.
    try { return await bounded(queued); }
    catch { diagnostic.mark('ATTEMPT_WAIT_EXPIRED'); expired = true; return { saved: false, message: uncertain }; }
  })();
  active.set(key, { operation, result: run });
  void run.finally(() => { if (active.get(key)?.result === run) active.delete(key); }).catch(() => {});
  return run;
}
