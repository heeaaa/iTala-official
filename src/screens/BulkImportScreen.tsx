import React, { useEffect, useRef, useState } from 'react';
import { useHeaderHeight } from '@react-navigation/elements';
import { View, ScrollView, TextInput, Pressable, Alert } from 'react-native';
import { Screen, Txt, Button, Card } from '../components/ui';
import { useStore, useLeague } from '../store/StoreProvider';
import { colors, space, radius, font, teamColors } from '../theme';
import { ScreenProps } from '../navigation';
import { uid } from '../lib/format';
import { parseRoster, promoteStrayToTeam, ParsedTeam } from '../lib/rosterParse';
import { useAdmin } from '../store/AdminProvider';
import { clearRosterDraft, loadRosterDraft, RosterDraft, saveRosterDraft } from '../store/rosterDraft';
import { getSupabase } from '../sync/supabase';
import { submitRosterImport, refreshImportedRoster } from '../sync/rosterImport';

export default function BulkImportScreen({ route, navigation }: ScreenProps<'BulkImport'>) {
  const { synced } = useStore();
  const { user } = useAdmin();
  const actorId = synced ? user?.id : 'local';
  if (!actorId) return <Screen><Txt k="body">Sign in to resume your roster import.</Txt></Screen>;
  // Changing account or league unmounts all editor state and pending callbacks.
  return <RosterImportEditor key={`${actorId}:${route.params.leagueId}`} actorId={actorId} route={route} navigation={navigation} />;
}

function RosterImportEditor({ route, navigation, actorId }: ScreenProps<'BulkImport'> & { actorId: string }) {
  const headerHeight = useHeaderHeight();
  const { leagueId } = route.params;
  const league = useLeague(leagueId);
  const { dispatch, synced, loadLeagueDetail } = useStore();
  const [draft, setDraft] = useState<RosterDraft>({ version: 1, actorId, leagueId, text: '', teams: null, operation: null });
  const draftRef = useRef(draft);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const text = draft.text, teams = draft.teams;

  useEffect(() => {
    mounted.current = true;
    if (!synced) { setReady(true); return () => { mounted.current = false; }; }
    void loadRosterDraft(actorId, leagueId).then(saved => {
      if (!mounted.current) return;
      if (saved) { draftRef.current = saved; setDraft(saved); }
      setReady(true);
    }).catch(() => {
      if (mounted.current) setMessage('The saved draft could not be loaded. Close this screen and try again.');
    });
    return () => { mounted.current = false; };
  }, [actorId, leagueId, synced]);

  const updateDraft = (next: RosterDraft) => {
    draftRef.current = next;
    setDraft(next);
    if (!synced) return;
    void saveRosterDraft(next).catch(() => {
      if (mounted.current) setMessage('Changes could not be saved on this device. Keep this screen open and free some storage.');
    });
  };
  const setText = (value: string) => { if (!submitting.current && !draftRef.current.operation) updateDraft({ ...draftRef.current, text: value }); };
  const setTeams: React.Dispatch<React.SetStateAction<ParsedTeam[] | null>> = value => {
    if (submitting.current || draftRef.current.operation) return;
    updateDraft({ ...draftRef.current, teams: typeof value === 'function' ? value(draftRef.current.teams) : value });
  };

  const submit = async (pending: RosterDraft) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setMessage(null);
    draftRef.current = pending;
    setDraft(pending);
    try {
      const sb = getSupabase();
      if (!sb) throw new Error('Sync unavailable');
      // The service persists this operation before sending any request.
      const result = await submitRosterImport(sb, pending);
      if (!mounted.current) return;
      if (!result.saved) { setMessage(result.message); return; }
      if (!await refreshImportedRoster(() => loadLeagueDetail(leagueId))) {
        if (!mounted.current) return;
        setMessage('Your roster is saved. We could not refresh this league yet. Retry to load it; the import will not be repeated.');
        return;
      }
      if (!mounted.current) return;
      await clearRosterDraft(actorId, leagueId);
      if (mounted.current) navigation.goBack();
    } catch {
      if (mounted.current) setMessage('The import could not finish. Your draft is kept here. Check your connection and device storage, then retry.');
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  if (!league) return <Screen><Txt k="body">League not found.</Txt></Screen>;
  if (!ready) return <Screen><Txt k="body">{message ?? 'Loading your import draft…'}</Txt></Screen>;
  if (draft.operation) return (
    <Screen scroll>
      <Txt k="h1">{busy ? 'Saving roster…' : 'Resume roster import'}</Txt>
      <Txt k="body" style={{ marginTop: space(3) }}>
        {draft.operation.teams.length} teams · {draft.operation.teams.reduce((n, t) => n + t.players.length, 0)} players
      </Txt>
      <Txt k="body" style={{ marginVertical: space(3) }}>
        {message ?? (busy ? 'Waiting for confirmation. Your draft is kept on this device.' : 'Your draft is kept on this device. Retry checks the earlier import before completing it safely.')}
      </Txt>
      {draft.operation.teams.map(team => (
        <Card key={team.id} style={{ marginBottom: space(3) }}>
          <Txt k="h2">{team.name}</Txt>
          {team.players.map(player => <Txt key={player.id} k="body">{player.number ? `#${player.number} · ` : ''}{player.name}</Txt>)}
        </Card>
      ))}
      <Button title={busy ? 'Saving…' : 'Retry import'} disabled={busy} onPress={() => { void submit(draftRef.current); }} />
      {!busy && <Button title="Back to league" kind="ghost" style={{ marginTop: space(2) }} onPress={() => navigation.goBack()} />}
    </Screen>
  );

  const playerCount = (ts: ParsedTeam[]) => ts.reduce((n, t) => n + t.players.length, 0);

  // ---- edit helpers (all immutable so React re-renders) ----
  const editTeamName = (ti: number, name: string) =>
    setTeams(ts => ts!.map((t, i) => i === ti ? { ...t, name } : t));
  const deleteTeam = (ti: number) =>
    setTeams(ts => ts!.filter((_, i) => i !== ti));
  const editPlayer = (ti: number, pi: number, patch: Partial<{ name: string; number: string }>) =>
    setTeams(ts => ts!.map((t, i) => i !== ti ? t : {
      ...t,
      players: t.players.map((p, j) => j !== pi ? p : { ...p, ...patch, flag: undefined }),
    }));
  const deletePlayer = (ti: number, pi: number) =>
    setTeams(ts => ts!.map((t, i) => i !== ti ? t : { ...t, players: t.players.filter((_, j) => j !== pi) }));
  const addPlayerRow = (ti: number) =>
    setTeams(ts => ts!.map((t, i) => i !== ti ? t : { ...t, players: [...t.players, { name: '', number: '', raw: '' }] }));
  const addTeamRow = () =>
    setTeams(ts => [...(ts ?? []), { name: `Team ${(ts?.length ?? 0) + 1}`, players: [] }]);
  // A flagged row is either a genuine stray or a team header that was pasted with
  // no blank line before it. The parser cannot tell (see rosterParse) so it flags
  // instead of guessing; this is the one-tap fix for the header case, and it
  // carries the rows below the header into the new team.
  const promoteToTeam = (ti: number, pi: number) =>
    setTeams(ts => promoteStrayToTeam(ts!, ti, pi));

  const commit = () => {
    const clean = (teams ?? [])
      .map(t => ({ ...t, players: t.players.filter(p => p.name.trim()) }))
      .filter(t => t.name.trim() && t.players.length > 0);
    if (clean.length === 0) { Alert.alert('Nothing to import', 'Add at least one team with one player.'); return; }
    const n = clean.length, m = playerCount(clean);
    Alert.alert('Create roster?', `Create ${n} team${n === 1 ? '' : 's'} and ${m} player${m === 1 ? '' : 's'} in ${league.name}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: `Create`, onPress: () => {
        if (!mounted.current || submitting.current || draftRef.current.operation) return;
        if (!synced) {
          submitting.current = true;
          dispatch({ t: 'BULK_IMPORT_ROSTER', leagueId, teams: clean.map(t => ({
            id: uid(), name: t.name.trim(),
            players: t.players.map(p => ({ id: uid(), name: p.name.trim(), number: p.number.trim() })),
          })) });
          navigation.goBack();
          return;
        }
        void submit({ ...draftRef.current, operation: {
          id: uid(),
          teams: clean.map((t, index) => ({
            id: uid(),
            name: t.name.trim(),
            color: teamColors[index % teamColors.length],
            players: t.players.map(p => ({ id: uid(), name: p.name.trim(), number: p.number.trim() })),
          })),
        } });
      } },
    ]);
  };

  // ============================== PASTE PHASE ==============================
  if (teams === null) {
    return (
      <Screen keyboardVerticalOffset={headerHeight}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space(4), paddingBottom: space(4) }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
          <Txt k="h1">Bulk import roster</Txt>
          {message && <Txt k="body" color={colors.red}>{message}</Txt>}
          <Txt k="body" color={colors.muted} style={{ marginTop: 4, marginBottom: space(3), fontSize: 13 }}>
            Paste your teams and players — each team name on its own line, players below it. Numbers can be written any way: "Juan-17", "Juan 22", "#24", "Juan#14". Nicknames inside ( ) are dropped.
          </Txt>
          <TextInput
            value={text} onChangeText={setText} multiline
            placeholder={"Team A\n\n1. Player One - 17\n2. Juan Dela Cruz #19\n…"}
            placeholderTextColor={colors.muted}
            textAlignVertical="top"
            style={{ minHeight: 280, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, color: colors.text, padding: 14, fontFamily: font.body, fontSize: 14, lineHeight: 20 }}
          />
        </ScrollView>
        <View style={{ padding: space(4), backgroundColor: colors.bg }}>
          <Button title="Preview" onPress={() => {
            const parsed = parseRoster(text);
            if (parsed.length === 0 || playerCount(parsed) === 0) {
              Alert.alert('Nothing recognized', 'Could not find any teams or players in that text. Check the format and try again.');
              return;
            }
            setTeams(parsed);
          }} />
        </View>
      </Screen>
    );
  }

  // ============================= REVIEW PHASE ==============================
  const nTeams = teams.filter(t => t.players.some(p => p.name.trim())).length;
  const nPlayers = playerCount(teams.map(t => ({ ...t, players: t.players.filter(p => p.name.trim()) })));

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space(4), paddingBottom: space(12) }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
        <Txt k="h1">Review roster</Txt>
        {message && <Txt k="body" color={colors.red}>{message}</Txt>}
        <Txt k="body" color={colors.muted} style={{ marginTop: 4, marginBottom: space(2), fontSize: 13 }}>
          {nTeams} team{nTeams === 1 ? '' : 's'} · {nPlayers} player{nPlayers === 1 ? '' : 's'} — everything is editable. Amber rows need a look before you create.
        </Txt>

        {teams.map((t, ti) => (
          <Card key={ti} style={{ marginBottom: space(3) }}>
            {/* Team header: editable name + delete team */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <TextInput
                value={t.name} onChangeText={(v) => editTeamName(ti, v)}
                placeholder="Team name" placeholderTextColor={colors.muted}
                style={{ flex: 1, backgroundColor: colors.bg, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, color: colors.text, paddingHorizontal: 12, paddingVertical: 9, fontFamily: font.bodyBold, fontSize: 16 }}
              />
              <Pressable onPress={() => Alert.alert('Delete team?', `Remove "${t.name}" and its ${t.players.length} players from the import?`, [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete', style: 'destructive', onPress: () => deleteTeam(ti) },
              ])} hitSlop={8}>
                <Txt k="body" color={colors.red}>✕</Txt>
              </Pressable>
            </View>

            {/* Player rows */}
            {t.players.map((p, pi) => (
              <View key={pi} style={{
                flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5,
                borderLeftWidth: p.flag ? 3 : 0, borderLeftColor: colors.yellow,
                paddingLeft: p.flag ? 8 : 0, marginLeft: p.flag ? -8 : 0,
              }}>
                <TextInput
                  value={p.number} onChangeText={(v) => editPlayer(ti, pi, { number: v })}
                  placeholder="#" placeholderTextColor={colors.muted} keyboardType="number-pad" maxLength={3}
                  style={{ width: 52, backgroundColor: colors.bg, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, color: colors.text, paddingHorizontal: 8, paddingVertical: 7, fontFamily: font.body, fontSize: 14, textAlign: 'center' }}
                />
                <View style={{ flex: 1 }}>
                  <TextInput
                    value={p.name} onChangeText={(v) => editPlayer(ti, pi, { name: v })}
                    placeholder="Player name" placeholderTextColor={colors.muted}
                    style={{ backgroundColor: colors.bg, borderRadius: radius.sm, borderWidth: 1, borderColor: p.flag ? colors.yellow : colors.line, color: colors.text, paddingHorizontal: 10, paddingVertical: 7, fontFamily: font.body, fontSize: 14 }}
                  />
                  {p.flag ? (
                    <>
                      <Txt k="body" color={colors.yellow} style={{ fontSize: 11, marginTop: 2 }}>⚠ {p.flag}</Txt>
                      <Pressable
                        onPress={() => promoteToTeam(ti, pi)}
                        hitSlop={10}
                        style={{ paddingVertical: 6, alignSelf: 'flex-start' }}
                        accessibilityRole="button"
                        accessibilityLabel={`Make ${p.name.trim() || 'this row'} a team`}
                        accessibilityHint="Starts a new team here and moves the rows below it into that team"
                      >
                        <Txt k="body" color={colors.brandTeal} style={{ fontSize: 12 }}>
                          ↳ Make this a team
                        </Txt>
                      </Pressable>
                    </>
                  ) : null}
                </View>
                <Pressable onPress={() => deletePlayer(ti, pi)} hitSlop={8}>
                  <Txt k="body" color={colors.muted}>✕</Txt>
                </Pressable>
              </View>
            ))}

            <Pressable onPress={() => addPlayerRow(ti)} style={{ paddingVertical: 8 }}>
              <Txt k="body" color={colors.brandTeal} style={{ fontSize: 13 }}>＋ Add player</Txt>
            </Pressable>
          </Card>
        ))}

        <Pressable onPress={addTeamRow} style={{ paddingVertical: 4, marginBottom: space(3) }}>
          <Txt k="body" color={colors.brandTeal}>＋ Add team</Txt>
        </Pressable>

        <Button title={`Create ${nTeams} teams & ${nPlayers} players`} onPress={commit} />
        <Button title="Back to paste" kind="ghost" style={{ marginTop: space(2) }} onPress={() => setTeams(null)} />
      </ScrollView>
    </Screen>
  );
}
