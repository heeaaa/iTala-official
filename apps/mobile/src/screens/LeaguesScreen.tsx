import React, { useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Button, Card, Empty, Icon, Pill, Screen, Txt, Wordmark } from '../ui/index';
import { colors, space } from '../theme';
import { useStore } from '../store/StoreProvider';
import { useAdmin } from '../store/AdminProvider';
import { PasswordSheet } from '../components/PasswordSheet';
import { SyncBanner } from '../components/SyncBanner';
import type { RootStackParams } from '../navigation';

type Props = NativeStackScreenProps<RootStackParams, 'Leagues'>;

export function LeaguesScreen({ navigation }: Props): React.JSX.Element {
  const { state, ready } = useStore();
  const { isAdmin, lock } = useAdmin();
  const [asking, setAsking] = useState(false);

  const leagues = state.leagues.filter((l) => l.kind !== 'recreational');

  return (
    <Screen>
      <View style={{ padding: space(4), gap: space(3) }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
          <View style={{ flex: 1 }}>
            <Wordmark size={40} />
            <Txt color={colors.muted} style={{ marginTop: space(2) }}>
              Record. Track. Elevate.
            </Txt>
          </View>
          <View style={{ flexDirection: 'row', gap: space(2) }}>
            {isAdmin ? (
              <IconButton
                name="settings"
                label="Settings"
                onPress={() => {
                  const first = leagues[0];
                  if (first) navigation.navigate('LeagueSettings', { leagueId: first.id });
                }}
              />
            ) : null}
            <IconButton
              name={isAdmin ? 'unlock' : 'lock'}
              label={isAdmin ? 'Lock admin mode' : 'Unlock admin mode'}
              tint={isAdmin ? colors.accent : colors.muted}
              onPress={() => (isAdmin ? void lock() : setAsking(true))}
            />
          </View>
        </View>

        {isAdmin ? (
          <Pill label="ADMIN MODE - stat tracking unlocked" color={colors.accentDim} />
        ) : null}
        <SyncBanner />
      </View>

      <FlatList
        data={leagues}
        keyExtractor={(l) => l.id}
        contentContainerStyle={{
          paddingHorizontal: space(4),
          paddingBottom: space(28),
          gap: space(3),
        }}
        ListEmptyComponent={
          ready ? (
            <Empty
              title="No leagues yet"
              subtitle="Create your first league to start tracking games."
            />
          ) : null
        }
        renderItem={({ item }) => {
          const played = item.games.filter((g) => g.status === 'final').length;
          const live = item.games.some((g) => g.status === 'live');
          return (
            <Card
              onPress={() => navigation.navigate('LeagueDetail', { leagueId: item.id })}
              accessibilityLabel={`${item.name}, ${item.season}, ${item.teams.length} teams, ${played} games played`}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ flex: 1 }}>
                  <Txt k="h2">{item.name}</Txt>
                  <Txt color={colors.muted} style={{ marginTop: space(1) }}>
                    {item.season}
                  </Txt>
                </View>
                {live ? (
                  <Pill label="LIVE" color={colors.accentDim} textColor={colors.live} />
                ) : null}
                <Icon name="next" color={colors.muted} />
              </View>
              <View style={{ flexDirection: 'row', gap: space(2), marginTop: space(3) }}>
                <Pill label={`${item.teams.length} teams`} />
                <Pill label={`${item.players.length} players`} />
                <Pill label={`${played} games played`} />
              </View>
            </Card>
          );
        }}
      />

      {isAdmin ? (
        <View style={{ position: 'absolute', left: space(4), right: space(4), bottom: space(6) }}>
          <Button
            title="New League"
            icon="plus"
            onPress={() => navigation.navigate('CreateLeague')}
          />
        </View>
      ) : null}

      <PasswordSheet
        visible={asking}
        message="Enter the admin password to unlock stat tracking (Start Game and live editing)."
        onClose={() => setAsking(false)}
      />
    </Screen>
  );
}

function IconButton({
  name,
  label,
  onPress,
  tint = colors.muted,
}: {
  name: 'settings' | 'lock' | 'unlock';
  label: string;
  onPress: () => void;
  tint?: string;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
    >
      <Icon name={name} size={20} color={tint} />
    </Pressable>
  );
}
