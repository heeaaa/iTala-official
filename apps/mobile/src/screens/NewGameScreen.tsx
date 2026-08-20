import React, { useState } from 'react';
import { View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { uid } from '@itala/domain';
import { Button, Card, Empty, Field, Screen, TeamBadge, Txt } from '../ui/index';
import { colors, radius, space } from '../theme';
import { useStore } from '../store/StoreProvider';
import type { RootStackParams } from '../navigation';

type Props = NativeStackScreenProps<RootStackParams, 'NewGame'>;

export function NewGameScreen({ route, navigation }: Props): React.JSX.Element {
  const { state, dispatch } = useStore();
  const league = state.leagues.find((l) => l.id === route.params.leagueId);
  const [home, setHome] = useState<string | null>(null);
  const [away, setAway] = useState<string | null>(null);
  const [location, setLocation] = useState('');

  if (!league)
    return (
      <Screen scroll>
        <Empty title="League not found." />
      </Screen>
    );
  const teams = league.teams.filter((t) => !t.deletedAt);

  // First tap picks home; tapping a selected side clears it; anything else
  // becomes away. Home and away can therefore never be the same team.
  const tap = (id: string): void => {
    if (home === id) return setHome(null);
    if (away === id) return setAway(null);
    if (home === null) return setHome(id);
    setAway(id);
  };

  const start = async (): Promise<void> => {
    if (!home || !away) return;
    const id = uid();
    await dispatch({
      t: 'CREATE_GAME',
      id,
      now: Date.now(),
      leagueId: league.id,
      homeTeamId: home,
      awayTeamId: away,
      location,
    });
    navigation.replace('SelectLineup', { leagueId: league.id, gameId: id });
  };

  return (
    <Screen scroll>
      <Txt k="h1">New Game</Txt>
      <Txt color={colors.muted} style={{ marginBottom: space(2) }}>
        Tap to pick home, then away.
      </Txt>

      {teams.map((team) => {
        const role = home === team.id ? 'HOME' : away === team.id ? 'AWAY' : null;
        return (
          <Card
            key={team.id}
            onPress={() => tap(team.id)}
            accessibilityLabel={`${team.name}${role ? `, selected as ${role.toLowerCase()}` : ''}`}
            style={{
              borderWidth: 2,
              borderColor: role ? team.color : colors.line,
              borderRadius: radius.lg,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(3) }}>
              <TeamBadge color={team.color} logoUrl={team.logoUrl} size={16} />
              <Txt k="h2" style={{ flex: 1 }}>
                {team.name}
              </Txt>
              {role ? (
                <Txt k="label" color={team.color}>
                  {role}
                </Txt>
              ) : null}
            </View>
          </Card>
        );
      })}

      <Field
        label="Location (optional)"
        value={location}
        onChangeText={setLocation}
        placeholder="Main Gym, Court 2"
      />
      <Button
        title="Next: lineups"
        icon="next"
        disabled={!home || !away}
        onPress={() => void start()}
      />
    </Screen>
  );
}
