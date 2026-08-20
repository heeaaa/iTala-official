import React, { useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { uid } from '@itala/domain';
import { Button, Field, Screen, Txt } from '../ui/index';
import { colors, space } from '../theme';
import { useStore } from '../store/StoreProvider';
import type { RootStackParams } from '../navigation';

type Props = NativeStackScreenProps<RootStackParams, 'CreateLeague'>;

export function CreateLeagueScreen({ navigation }: Props): React.JSX.Element {
  const { dispatch } = useStore();
  const [name, setName] = useState('');
  const [season, setSeason] = useState('');

  const create = async (): Promise<void> => {
    const id = uid();
    await dispatch({ t: 'ADD_LEAGUE', id, now: Date.now(), name, season });
    // Replace, so Back does not return to an empty form.
    navigation.replace('ManageRoster', { leagueId: id });
  };

  return (
    <Screen scroll>
      <Txt k="h1">New League</Txt>
      <Txt color={colors.muted} style={{ marginBottom: space(4) }}>
        Everything else lives inside a league: teams, players, games and stats.
      </Txt>
      <Field
        label="League name"
        value={name}
        onChangeText={setName}
        placeholder="Sunday Run, Office League..."
      />
      <Field label="Season" value={season} onChangeText={setSeason} placeholder="Spring 2026" />
      <Button
        title="Create and add teams"
        disabled={name.trim().length === 0}
        onPress={() => void create()}
      />
    </Screen>
  );
}
