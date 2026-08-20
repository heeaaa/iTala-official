import React, { useState } from 'react';
import { View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { uid } from '@itala/domain';
import { Button, Card, Empty, Field, Screen, TeamBadge, Txt } from '../ui/index';
import { colors, space } from '../theme';
import { useStore } from '../store/StoreProvider';
import type { RootStackParams } from '../navigation';

type Props = NativeStackScreenProps<RootStackParams, 'ManageRoster'>;

export function ManageRosterScreen({ route, navigation }: Props): React.JSX.Element {
  const { state, dispatch } = useStore();
  const league = state.leagues.find((l) => l.id === route.params.leagueId);
  const [teamName, setTeamName] = useState('');
  const [drafts, setDrafts] = useState<Record<string, { number: string; name: string }>>({});

  if (!league)
    return (
      <Screen scroll>
        <Empty title="League not found." />
      </Screen>
    );

  const teams = league.teams.filter((t) => !t.deletedAt);
  const draftFor = (id: string): { number: string; name: string } =>
    drafts[id] ?? { number: '', name: '' };

  const addTeam = async (): Promise<void> => {
    await dispatch({ t: 'ADD_TEAM', id: uid(), leagueId: league.id, name: teamName });
    setTeamName('');
  };

  const addPlayer = async (teamId: string): Promise<void> => {
    const d = draftFor(teamId);
    if (d.name.trim().length === 0) return;
    await dispatch({
      t: 'ADD_PLAYER',
      id: uid(),
      leagueId: league.id,
      teamId,
      name: d.name,
      number: d.number,
    });
    setDrafts((prev) => ({ ...prev, [teamId]: { number: '', name: '' } }));
  };

  const readyToPlay = teams.length >= 2;

  return (
    <Screen scroll>
      <Txt k="h1">{league.name}</Txt>
      <Txt color={colors.muted}>{league.season}</Txt>

      <Card style={{ marginTop: space(2) }}>
        <Txt k="label">Add a team</Txt>
        <View
          style={{
            flexDirection: 'row',
            gap: space(2),
            alignItems: 'flex-end',
            marginTop: space(2),
          }}
        >
          <View style={{ flex: 1 }}>
            <Field
              label="Team name"
              value={teamName}
              onChangeText={setTeamName}
              placeholder="Riptide"
              onSubmitEditing={() => void addTeam()}
            />
          </View>
          <Button
            title="Add"
            disabled={teamName.trim().length === 0}
            onPress={() => void addTeam()}
            style={{ marginBottom: space(3) }}
          />
        </View>
      </Card>

      {teams.map((team) => {
        const players = team.playerIds
          .map((pid) => league.players.find((p) => p.id === pid))
          .filter((p): p is NonNullable<typeof p> => Boolean(p) && !p?.deletedAt);
        const d = draftFor(team.id);
        return (
          <Card key={team.id}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2) }}>
              <TeamBadge color={team.color} logoUrl={team.logoUrl} size={14} />
              <Txt k="h2" style={{ flex: 1 }}>
                {team.name}
              </Txt>
              <Txt k="label">{players.length} players</Txt>
            </View>

            {players.length === 0 ? (
              <Txt color={colors.muted} style={{ marginTop: space(3) }}>
                No players.
              </Txt>
            ) : (
              players.map((p) => (
                <View
                  key={p.id}
                  style={{
                    flexDirection: 'row',
                    gap: space(3),
                    marginTop: space(3),
                    alignItems: 'center',
                  }}
                >
                  <Txt k="label" style={{ width: 34 }}>
                    {p.number ? `#${p.number}` : '-'}
                  </Txt>
                  <Txt style={{ flex: 1 }}>{p.name}</Txt>
                </View>
              ))
            )}

            <View
              style={{
                flexDirection: 'row',
                gap: space(2),
                alignItems: 'flex-end',
                marginTop: space(3),
              }}
            >
              <View style={{ width: 76 }}>
                <Field
                  label="#"
                  value={d.number}
                  onChangeText={(v) =>
                    setDrafts((prev) => ({ ...prev, [team.id]: { ...d, number: v } }))
                  }
                  keyboardType="number-pad"
                  placeholder="7"
                />
              </View>
              <View style={{ flex: 1 }}>
                <Field
                  label="Add player"
                  value={d.name}
                  onChangeText={(v) =>
                    setDrafts((prev) => ({ ...prev, [team.id]: { ...d, name: v } }))
                  }
                  placeholder="Player name"
                  onSubmitEditing={() => void addPlayer(team.id)}
                />
              </View>
              <Button
                title="Add"
                icon="plus"
                disabled={d.name.trim().length === 0}
                onPress={() => void addPlayer(team.id)}
                style={{ marginBottom: space(3) }}
              />
            </View>
          </Card>
        );
      })}

      <Button
        title={readyToPlay ? 'Done, go to the league' : 'Done'}
        kind={readyToPlay ? 'primary' : 'ghost'}
        onPress={() => navigation.replace('LeagueDetail', { leagueId: league.id })}
        accessibilityHint={
          readyToPlay ? undefined : 'A league needs two teams before a game can start'
        }
      />
    </Screen>
  );
}
