import React, { useState } from 'react';
import { View, TextInput, Pressable, ScrollView } from 'react-native';
import { Screen, Txt, Card, Button, Pill, TeamBadge } from '../components/ui';
import { useStore, useLeague } from '../store/StoreProvider';
import { useAdmin } from '../store/AdminProvider';
import { colors, space, radius, font } from '../theme';
import { ScreenProps } from '../navigation';

export default function ManageRosterScreen({ route, navigation }: ScreenProps<'ManageRoster'>) {
  const { leagueId } = route.params;
  const { dispatch } = useStore();
  const league = useLeague(leagueId);
  const { canScore, isOwner } = useAdmin();
  const [teamName, setTeamName] = useState('');
  const [opponentOnly, setOpponentOnly] = useState(false);
  const [playerDraft, setPlayerDraft] = useState<Record<string, { name: string; num: string }>>({});

  if (!league) return <Screen><Txt k="body">League not found.</Txt></Screen>;
  const owner = isOwner(league);
  const scorer = canScore(league);

  const addTeam = () => {
    if (!teamName.trim()) return;
    dispatch({ t: 'ADD_TEAM', leagueId, name: teamName, teamOnly: opponentOnly });
    setTeamName(''); setOpponentOnly(false);
  };

  const addPlayer = (teamId: string) => {
    const d = playerDraft[teamId];
    if (!d || !d.name.trim()) return;
    dispatch({ t: 'ADD_PLAYER', leagueId, teamId, name: d.name, number: d.num || undefined });
    setPlayerDraft(p => ({ ...p, [teamId]: { name: '', num: '' } }));
  };

  const canStart = league.teams.filter(t => !t.teamOnly).length >= 1 && league.teams.length >= 2;

  // Alphabetical, always. Team order in state can shift as syncs land; the
  // list you're typing into must never move under your fingers.
  const sortedTeams = [...league.teams].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space(4), paddingBottom: space(28) }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
        <Txt k="h1">{league.name}</Txt>
        <Txt k="body" color={colors.muted} style={{ marginBottom: space(5) }}>{league.season}</Txt>

        {scorer && (<>
        {owner && league.kind !== 'recreational' && league.teams.length === 0 && (
          <Button
            title="Bulk import roster (paste teams & players)"
            kind="ghost"
            style={{ marginBottom: space(4) }}
            onPress={() => navigation.navigate('BulkImport', { leagueId })}
          />
        )}
        <Txt k="label" style={{ marginBottom: 8 }}>Add a team</Txt>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <TextInput
            value={teamName} onChangeText={setTeamName} placeholder="Team name"
            placeholderTextColor={colors.muted}
            style={{ flex: 1, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, color: colors.text, paddingHorizontal: 14, paddingVertical: 12, fontFamily: font.body, fontSize: 16 }}
          />
          <Button title="Add" onPress={addTeam} style={{ paddingVertical: 12 }} />
        </View>
        {/* "Track as opponent only (score, no player stats)" named the setting
            without saying what it gets you, so the only way to find out was to
            create a team and see. Say what it is FOR - the visiting side whose
            roster you do not have - and what changes: one tap logs the whole
            team's basket, and there is no box score for them. */}
        <Pressable
          onPress={() => setOpponentOnly(v => !v)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: opponentOnly }}
          accessibilityLabel="Score only, no player stats"
          accessibilityHint="For an opponent whose roster you do not have. Their points are logged as a team total instead of per player."
          style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 12, paddingVertical: 4 }}>
          <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: opponentOnly ? colors.accent : colors.line, backgroundColor: opponentOnly ? colors.accent : 'transparent', alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
            {opponentOnly ? <Txt k="body" color={colors.bg}>✓</Txt> : null}
          </View>
          <View style={{ flex: 1 }}>
            <Txt k="body">Score only, no player stats</Txt>
            <Txt k="body" color={colors.muted} style={{ fontSize: 13, marginTop: 2 }}>
              For a visiting side whose roster you don&apos;t have. You add no players, and in the
              live tracker one tap logs the whole team&apos;s basket. They get a score and a
              W-L record, but no individual stats and no box score.
            </Txt>
          </View>
        </Pressable>
        </>)}

        <View style={{ height: space(5) }} />

        {sortedTeams.map(team => (
          <Card key={team.id} style={{ marginBottom: space(3) }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: space(2) }}>
              <TeamBadge logo={team.logo} color={team.color} size={16} />
              <Txt k="h2" style={{ flex: 1 }}>{team.name}</Txt>
              {team.teamOnly ? <Pill label="opponent" color={colors.surfaceHi} textColor={colors.muted} /> : <Pill label={`${team.playerIds.length}`} />}
              {scorer && (
                <Pressable onPress={() => navigation.navigate('EditTeam', { leagueId, teamId: team.id })} hitSlop={8}
                  style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line }}>
                  <Txt k="body" style={{ fontSize: 13 }}>✎ Edit</Txt>
                </Pressable>
              )}
            </View>

            {!team.teamOnly && (
              <>
                {team.playerIds.map(pid => {
                  const p = league.players.find(x => x.id === pid);
                  if (!p) return null;
                  return (
                    <View key={pid} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 10 }}>
                      <Txt k="stat" color={colors.muted} style={{ width: 34 }}>{p.number ? `#${p.number}` : '—'}</Txt>
                      <Txt k="body" style={{ flex: 1 }}>{p.name}</Txt>
                    </View>
                  );
                })}
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                  <TextInput
                    value={playerDraft[team.id]?.num ?? ''} onChangeText={v => setPlayerDraft(p => ({ ...p, [team.id]: { name: p[team.id]?.name ?? '', num: v } }))}
                    placeholder="#" placeholderTextColor={colors.muted} keyboardType="number-pad"
                    style={{ width: 56, backgroundColor: colors.bg, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, color: colors.text, paddingHorizontal: 10, paddingVertical: 10, fontFamily: font.body, textAlign: 'center' }}
                  />
                  <TextInput
                    value={playerDraft[team.id]?.name ?? ''} onChangeText={v => setPlayerDraft(p => ({ ...p, [team.id]: { num: p[team.id]?.num ?? '', name: v } }))}
                    placeholder="Add player" placeholderTextColor={colors.muted}
                    onSubmitEditing={() => addPlayer(team.id)}
                    style={{ flex: 1, backgroundColor: colors.bg, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, color: colors.text, paddingHorizontal: 12, paddingVertical: 10, fontFamily: font.body }}
                  />
                  <Button title="+" onPress={() => addPlayer(team.id)} style={{ paddingVertical: 10, paddingHorizontal: 16 }} />
                </View>
              </>
            )}
          </Card>
        ))}
      </ScrollView>

      <View style={{ position: 'absolute', left: space(4), right: space(4), bottom: space(6), gap: 8 }}>
        <Button title="Done — go to league" onPress={() => navigation.replace('LeagueDetail', { leagueId })} kind={canStart ? 'primary' : 'ghost'} />
      </View>
    </Screen>
  );
}
