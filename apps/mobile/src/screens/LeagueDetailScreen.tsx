import React from 'react';
import { View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { gameScore, type Game, type League } from '@itala/domain';
import { Button, Card, Empty, Icon, LivePip, Pill, Screen, TeamBadge, Txt } from '../ui/index';
import { colors, space } from '../theme';
import { useStore } from '../store/StoreProvider';
import { useAdmin } from '../store/AdminProvider';
import { SyncBanner } from '../components/SyncBanner';
import type { RootStackParams } from '../navigation';

type Props = NativeStackScreenProps<RootStackParams, 'LeagueDetail'>;

/**
 * Phase 2 shows a flat list of games. Grouping by day, standings, leaders and
 * roster search all arrive in Phase 3.
 */
export function LeagueDetailScreen({ route, navigation }: Props): React.JSX.Element {
  const { state } = useStore();
  const { isAdmin } = useAdmin();
  const league = state.leagues.find((l) => l.id === route.params.leagueId);

  if (!league)
    return (
      <Screen scroll>
        <Empty title="League not found." />
      </Screen>
    );

  const teams = league.teams.filter((t) => !t.deletedAt);

  return (
    <Screen scroll>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}>
          <Txt k="h1">{league.name}</Txt>
          <Txt color={colors.muted}>{league.season}</Txt>
        </View>
        {isAdmin ? (
          <Button
            title="Settings"
            kind="ghost"
            icon="settings"
            onPress={() => navigation.navigate('LeagueSettings', { leagueId: league.id })}
          />
        ) : null}
      </View>

      <SyncBanner />

      {isAdmin ? (
        <View style={{ flexDirection: 'row', gap: space(3) }}>
          <Button
            title="Start Game"
            icon="play"
            disabled={teams.length < 2}
            onPress={() => navigation.navigate('NewGame', { leagueId: league.id })}
            style={{ flex: 1 }}
            accessibilityHint={teams.length < 2 ? 'Add at least two teams first' : undefined}
          />
          <Button
            title="Roster"
            kind="ghost"
            onPress={() => navigation.navigate('ManageRoster', { leagueId: league.id })}
            style={{ flex: 1 }}
          />
        </View>
      ) : null}

      {league.games.length === 0 ? (
        <Empty title="No games yet" subtitle="Tap Start Game to keep stats live." />
      ) : (
        league.games.map((game) => (
          <GameRow
            key={game.id}
            league={league}
            game={game}
            onPress={() =>
              game.status === 'live'
                ? navigation.navigate('LiveGame', {
                    leagueId: league.id,
                    gameId: game.id,
                    spectator: !isAdmin,
                  })
                : navigation.navigate('BoxScore', { leagueId: league.id, gameId: game.id })
            }
          />
        ))
      )}
    </Screen>
  );
}

function GameRow({
  league,
  game,
  onPress,
}: {
  league: League;
  game: Game;
  onPress: () => void;
}): React.JSX.Element {
  const home = league.teams.find((t) => t.id === game.homeTeamId);
  const away = league.teams.find((t) => t.id === game.awayTeamId);
  const score = gameScore(league, game);
  const live = game.status === 'live';
  const homeWon = score.home > score.away;
  const awayWon = score.away > score.home;

  return (
    <Card
      onPress={onPress}
      accessibilityLabel={`${home?.name ?? 'Home'} ${score.home}, ${away?.name ?? 'Away'} ${score.away}, ${live ? 'live' : 'final'}`}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space(3) }}>
        {live ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2) }}>
            <LivePip />
            <Txt k="label" color={colors.live}>
              Live
            </Txt>
          </View>
        ) : (
          <Pill label="FINAL" />
        )}
        <View style={{ flex: 1 }} />
        {game.location ? <Txt k="label">{game.location}</Txt> : null}
        <Icon name="next" color={colors.muted} />
      </View>

      <SideRow
        name={home?.name ?? 'Home'}
        color={home?.color ?? colors.muted}
        logoUrl={home?.logoUrl}
        score={score.home}
        dim={!live && !homeWon}
      />
      <SideRow
        name={away?.name ?? 'Away'}
        color={away?.color ?? colors.muted}
        logoUrl={away?.logoUrl}
        score={score.away}
        dim={!live && !awayWon}
      />
    </Card>
  );
}

function SideRow({
  name,
  color,
  logoUrl,
  score,
  dim,
}: {
  name: string;
  color: string;
  logoUrl?: string | null;
  score: number;
  dim: boolean;
}): React.JSX.Element {
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), marginTop: space(1) }}
    >
      <TeamBadge color={color} logoUrl={logoUrl} size={14} />
      <Txt style={{ flex: 1 }} color={dim ? colors.muted : colors.text} numberOfLines={1}>
        {name}
      </Txt>
      <Txt k="statBig" color={dim ? colors.muted : colors.text}>
        {score}
      </Txt>
    </View>
  );
}
