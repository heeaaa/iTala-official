import React from 'react';
import { View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Card, Empty, Screen, Segmented, Toggle, Txt } from '../ui/index';
import { colors, space } from '../theme';
import { useStore } from '../store/StoreProvider';
import { useAdmin } from '../store/AdminProvider';
import type { RootStackParams } from '../navigation';

type Props = NativeStackScreenProps<RootStackParams, 'LeagueSettings'>;

/**
 * Per LEAGUE, not global. v1 had one boolean shared by every league on every
 * device, which forced a competitive league and a Tuesday pickup run to agree
 * on how much data to collect.
 */
export function LeagueSettingsScreen({ route }: Props): React.JSX.Element {
  const { state, dispatch, status } = useStore();
  const { isAdmin, deviceId } = useAdmin();
  const league = state.leagues.find((l) => l.id === route.params.leagueId);

  if (!league)
    return (
      <Screen scroll>
        <Empty title="League not found." />
      </Screen>
    );
  if (!isAdmin) {
    return (
      <Screen scroll>
        <Empty
          title="Admin only"
          subtitle="Unlock admin mode from the home screen to change settings."
        />
      </Screen>
    );
  }

  const set = (
    patch: Parameters<typeof dispatch>[0] extends never
      ? never
      : Partial<{
          trackMisses: boolean;
          trackTurnovers: boolean;
          foulOutLimit: number;
          regulationPeriods: 2 | 4;
        }>,
  ): void => {
    void dispatch({ t: 'UPDATE_LEAGUE_SETTINGS', leagueId: league.id, ...patch });
  };

  return (
    <Screen scroll>
      <Txt k="h1">{league.name}</Txt>
      <Txt color={colors.muted} style={{ marginBottom: space(2) }}>
        These apply to this league only, on every device.
      </Txt>

      <Card>
        <Txt k="label">Stat tracking</Txt>
        <View style={{ marginTop: space(2) }}>
          <Toggle
            label="Track missed shots"
            description="Shows the 2PT, 3PT and FT miss buttons on the tracker, and switches the box score to made-attempted so you get shooting percentages. Logging misses roughly doubles the taps per possession."
            value={league.trackMisses}
            onChange={(v) => set({ trackMisses: v })}
          />
          <Toggle
            label="Track turnovers"
            description="Adds a TOV button to the tracker. Without it the box score has a turnover column that can never be anything but zero."
            value={league.trackTurnovers}
            onChange={(v) => set({ trackTurnovers: v })}
          />
        </View>
      </Card>

      <Card>
        <Txt k="label">Game rules</Txt>
        <Txt
          color={colors.muted}
          style={{ fontSize: 13, marginTop: space(2), marginBottom: space(2) }}
        >
          Regulation length. Only changes how periods are labelled: overtime is always available.
        </Txt>
        <Segmented
          label="Regulation length"
          options={['2 halves', '4 quarters']}
          value={league.regulationPeriods === 2 ? 0 : 1}
          onChange={(i) => set({ regulationPeriods: i === 0 ? 2 : 4 })}
        />

        <Txt
          color={colors.muted}
          style={{ fontSize: 13, marginTop: space(4), marginBottom: space(2) }}
        >
          Personal fouls before a player fouls out.
        </Txt>
        <Segmented
          label="Foul out limit"
          options={['5 (FIBA)', '6 (NBA)']}
          value={league.foulOutLimit >= 6 ? 1 : 0}
          onChange={(i) => set({ foulOutLimit: i === 0 ? 5 : 6 })}
        />
      </Card>

      <Card>
        <Txt k="label">Sync</Txt>
        {status.enabled ? (
          <>
            <Txt color={colors.green} style={{ marginTop: space(2) }}>
              Connected. Changes sync across devices in real time.
            </Txt>
            <Txt color={colors.muted} style={{ fontSize: 13, marginTop: space(2) }}>
              {status.pending} waiting to send, {status.rejected} refused.
            </Txt>
            {deviceId ? (
              <Txt color={colors.muted} style={{ fontSize: 13, marginTop: space(1) }}>
                Device: {deviceId.slice(0, 8)}...
              </Txt>
            ) : null}
          </>
        ) : (
          <Txt color={colors.muted} style={{ marginTop: space(2) }}>
            Local-only. Data stays on this device. Set EXPO_PUBLIC_SUPABASE_URL and
            EXPO_PUBLIC_SUPABASE_ANON_KEY before building to enable sync.
          </Txt>
        )}
      </Card>
    </Screen>
  );
}
