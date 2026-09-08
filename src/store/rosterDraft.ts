import AsyncStorage from '@react-native-async-storage/async-storage';
import { ParsedTeam } from '../lib/rosterParse';

export interface ImportTeam {
  id: string; name: string; color: string;
  players: { id: string; name: string; number: string }[];
}
export interface RosterDraft {
  version: 1;
  actorId: string;
  leagueId: string;
  text: string;
  teams: ParsedTeam[] | null;
  // Once submitted this immutable operation is retained even after an uncertain
  // response. Editing/re-generating IDs could create a second roster.
  operation: { id: string; teams: ImportTeam[] } | null;
}
const key = (actorId: string, leagueId: string) =>
  `hoops.roster-draft.v1:${encodeURIComponent(actorId)}:${encodeURIComponent(leagueId)}`;
const writes = new Map<string, Promise<void>>();

export function isRosterDraft(value: unknown, actorId: string, leagueId: string): value is RosterDraft {
  if (!value || typeof value !== 'object') return false;
  const d = value as RosterDraft;
  const str = (v: unknown) => typeof v === 'string';
  const editorValid = d.teams === null || (Array.isArray(d.teams) && d.teams.every(t =>
    t && str(t.name) && Array.isArray(t.players) && t.players.every(p =>
      p && str(p.name) && str(p.number) && str(p.raw) && (p.flag === undefined || str(p.flag)))));
  const op = d.operation;
  const operationValid = op === null || (op && str(op.id) && op.id.length > 0 &&
    Array.isArray(op.teams) && op.teams.length > 0 && op.teams.every(t =>
      t && str(t.id) && !!t.id && str(t.name) && !!t.name.trim() && str(t.color) &&
      Array.isArray(t.players) && t.players.length > 0 && t.players.every(p =>
        p && str(p.id) && !!p.id && str(p.name) && !!p.name.trim() && str(p.number))));
  return d.version === 1 && d.actorId === actorId && d.leagueId === leagueId && str(d.text)
    && editorValid && !!operationValid;
}

// Serialize edits, submit persistence and deletion for each draft. A slower
// earlier autosave must never overwrite the submitted operation or resurrect it.
function write(actorId: string, leagueId: string, fn: () => Promise<void>): Promise<void> {
  const k = key(actorId, leagueId);
  const run = (writes.get(k) ?? Promise.resolve()).catch(() => {}).then(fn);
  writes.set(k, run);
  void run.finally(() => { if (writes.get(k) === run) writes.delete(k); }).catch(() => {});
  return run;
}
export async function loadRosterDraft(actorId: string, leagueId: string): Promise<RosterDraft | null> {
  await writes.get(key(actorId, leagueId))?.catch(() => {});
  const raw = await AsyncStorage.getItem(key(actorId, leagueId));
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('The saved import draft could not be read.'); }
  if (!isRosterDraft(parsed, actorId, leagueId)) throw new Error('The saved import draft could not be read.');
  return parsed;
}
export function saveRosterDraft(draft: RosterDraft): Promise<void> {
  const raw = JSON.stringify(draft);
  return write(draft.actorId, draft.leagueId, () => AsyncStorage.setItem(key(draft.actorId, draft.leagueId), raw));
}
export function clearRosterDraft(actorId: string, leagueId: string): Promise<void> {
  return write(actorId, leagueId, () => AsyncStorage.removeItem(key(actorId, leagueId)));
}

// Account deletion removes only that account's drafts, after its queued writes.
export async function clearAccountRosterDrafts(actorId: string): Promise<void> {
  const prefix = key(actorId, '');
  await Promise.allSettled([...writes].filter(([k]) => k.startsWith(prefix)).map(([, pending]) => pending));
  const keys = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith(prefix));
  if (keys.length) await AsyncStorage.multiRemove(keys);
}
