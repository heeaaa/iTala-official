import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { LINEUP_SIZE, type League, type Team } from '@itala/domain';
import { Button, Card, Empty, Screen, TeamBadge, Txt } from '../ui/index';
import { colors, radius, space } from '../theme';
import { useStore } from '../store/StoreProvider';
import type { RootStackParams } from '../navigation';

type Props = NativeStackScreenProps<RootStackParams, 'SelectLineup'>;

export function SelectLineupScreen({ route, navigation }: Props): React.JSX.Element {
  const { state, dispatch } = useStore();
  const league = state.leagues.find((l) => l.id === route.params.leagueId);
  const game = league?.games.find((g) => g.id === route.params.gameId);
  const home = league?.teams.find((t) => t.id === game?.homeTeamId);
  const away = league?.teams.find((t) => t.id === game?.awayTeamId);

  // The fast path is to accept: both sides pre-select their first five.
  const [picked, setPicked] = useState<Record<string, string[]>>(() => ({
    home: home?.playerIds.slice(0, LINEUP_SIZE) ?? [],
    away: away?.playerIds.slice(0, LINEUP_SIZE) ?? [],
  }));

  if (!league || !game || !home || !away) {
    return (
      <Screen scroll>
        <Empty title="Game not found." />
      </Screen>
    );
  }

  const toggle = (side: 'home' | 'away', playerId: string): void => {
    setPicked((prev) => {
      const current = prev[side] ?? [];
      if (current.includes(playerId)) {
        return { ...prev, [side]: current.filter((p) => p !== playerId) };
      }
      if (current.length >= LINEUP_SIZE) return prev;
      return { ...prev, [side]: [...current, playerId] };
    });
  };

  const tipOff = async (): Promise<void> => {
    await dispatch({
      t: 'SET_LINEUP',
      leagueId: league.id,
      gameId: game.id,
      side: 'home',
      playerIds: picked['home'] ?? [],
    });
    await dispatch({
      t: 'SET_LINEUP',
      leagueId: league.id,
      gameId: game.id,
      side: 'away',
      playerIds: picked['away'] ?? [],
    });
    navigation.replace('LiveGame', { leagueId: league.id, gameId: game.id, spectator: false });
  };

  const ready = (picked['home']?.length ?? 0) > 0 && (picked['away']?.length ?? 0) > 0;

  return (
    <Screen scroll>
      <Txt k="h1">Starting Lineups</Txt>
      <Txt color={colors.muted} style={{ marginBottom: space(2) }}>
        Pick the players starting on court for each team. You can sub anytime during the game.
      </Txt>

      {(['home', 'away'] as const).map((side) => (
        <TeamLineup
          key={side}
          league={league}
          team={side === 'home' ? home : away}
          selected={picked[side] ?? []}
          onToggle={(pid) => toggle(side, pid)}
        />
      ))}

      <Button title="Tip off" icon="play" disabled={!ready} onPress={() => void tipOff()} />
    </Screen>
  );
}

function TeamLineup({
  league,
  team,
  selected,
  onToggle,
}: {
  league: League;
  team: Team;
  selected: string[];
  onToggle: (playerId: string) => void;
}): React.JSX.Element {
  const roster = team.playerIds
    .map((pid) => league.players.find((p) => p.id === pid))
    .filter((p): p is NonNullable<typeof p> => Boolean(p) && !p?.deletedAt);
  const target = Math.min(LINEUP_SIZE, roster.length);
  const full = selected.length === target && target > 0;

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2) }}>
        <TeamBadge color={team.color} logoUrl={team.logoUrl} size={14} />
        <Txt k="h2" style={{ flex: 1 }}>
          {team.name}
        </Txt>
        <Txt k="stat" color={full ? colors.green : colors.muted}>
          {selected.length}/{target}
        </Txt>
      </View>

      {roster.length === 0 ? (
        <Txt color={colors.muted} style={{ marginTop: space(3) }}>
          No players on this team yet.
        </Txt>
      ) : (
        <View
          style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginTop: space(3) }}
        >
          {roster.map((p) => {
            const on = selected.includes(p.id);
            return (
              <Pressable
                key={p.id}
                onPress={() => onToggle(p.id)}
                accessibilityRole="checkbox"
                accessibilityLabel={`${p.name}${p.number ? `, number ${p.number}` : ''}`}
                accessibilityState={{ checked: on }}
                style={{
                  paddingVertical: space(2.5),
                  paddingHorizontal: space(3),
                  borderRadius: radius.pill,
                  borderWidth: 1,
                  borderColor: on ? team.color : colors.line,
                  backgroundColor: on ? `${team.color}33` : 'transparent',
                }}
              >
                <Txt color={on ? colors.text : colors.muted}>
                  {p.number ? `#${p.number} ` : ''}
                  {p.name}
                </Txt>
              </Pressable>
            );
          })}
        </View>
      )}
    </Card>
  );
}
