import React from 'react';
import { ScrollView, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  gameScore,
  lineScore,
  pct,
  periodLabel,
  showsAttempts,
  showsTurnovers,
  teamBoxScore,
  type League,
  type StatLine,
} from '@itala/domain';
import { Button, Card, Empty, LivePip, Pill, Screen, Segmented, TeamBadge, Txt } from '../ui/index';
import { colors, space } from '../theme';
import { useStore } from '../store/StoreProvider';
import type { RootStackParams } from '../navigation';

type Props = NativeStackScreenProps<RootStackParams, 'BoxScore'>;

export function BoxScoreScreen({ route, navigation }: Props): React.JSX.Element {
  const { state } = useStore();
  const [tab, setTab] = React.useState(0);

  const league = state.leagues.find((l) => l.id === route.params.leagueId);
  const game = league?.games.find((g) => g.id === route.params.gameId);

  if (!league || !game)
    return (
      <Screen scroll>
        <Empty title="Game not found." />
      </Screen>
    );

  const home = league.teams.find((t) => t.id === game.homeTeamId);
  const away = league.teams.find((t) => t.id === game.awayTeamId);
  const score = gameScore(league, game);
  const line = lineScore(league, game);
  const live = game.status === 'live';
  const shown = tab === 0 ? home : away;

  return (
    <Screen scroll>
      <Card>
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
        </View>

        <ScoreRow
          name={home?.name ?? 'Home'}
          color={home?.color ?? colors.muted}
          logoUrl={home?.logoUrl}
          score={score.home}
          dim={!live && score.home < score.away}
        />
        <ScoreRow
          name={away?.name ?? 'Away'}
          color={away?.color ?? colors.muted}
          logoUrl={away?.logoUrl}
          score={score.away}
          dim={!live && score.away < score.home}
        />
      </Card>

      <Card>
        <Txt k="label">By period</Txt>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ marginTop: space(2) }}
        >
          <View>
            <View style={{ flexDirection: 'row' }}>
              <Cell width={110} />
              {line.periods.map((p) => (
                <Cell key={p} width={46}>
                  <Txt k="label">{periodLabel(league, p)}</Txt>
                </Cell>
              ))}
              <Cell width={46}>
                <Txt k="label">T</Txt>
              </Cell>
            </View>
            {(
              [
                { name: home?.name ?? 'Home', values: line.home, total: score.home },
                { name: away?.name ?? 'Away', values: line.away, total: score.away },
              ] as const
            ).map((row) => (
              <View key={row.name} style={{ flexDirection: 'row', marginTop: space(2) }}>
                <Cell width={110} align="flex-start">
                  <Txt numberOfLines={1}>{row.name}</Txt>
                </Cell>
                {row.values.map((v, i) => (
                  <Cell key={i} width={46}>
                    <Txt k="stat">{v}</Txt>
                  </Cell>
                ))}
                <Cell width={46}>
                  <Txt k="stat" color={colors.accent}>
                    {row.total}
                  </Txt>
                </Cell>
              </View>
            ))}
          </View>
        </ScrollView>
      </Card>

      <Segmented
        label="Team"
        options={[home?.name ?? 'Home', away?.name ?? 'Away']}
        value={tab}
        onChange={setTab}
      />

      {shown ? <BoxTable league={league} gameId={game.id} teamId={shown.id} /> : null}

      {live ? (
        <Button
          title="Back to live game"
          icon="play"
          onPress={() => navigation.replace('LiveGame', { leagueId: league.id, gameId: game.id })}
        />
      ) : null}
    </Screen>
  );
}

function ScoreRow({
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
      style={{ flexDirection: 'row', alignItems: 'center', gap: space(3), marginTop: space(2) }}
    >
      <TeamBadge color={color} logoUrl={logoUrl} size={18} />
      <Txt k="h2" style={{ flex: 1 }} color={dim ? colors.muted : colors.text} numberOfLines={1}>
        {name}
      </Txt>
      <Txt k="display" color={dim ? colors.muted : colors.text}>
        {score}
      </Txt>
    </View>
  );
}

/**
 * Column set depends on the league's settings: with misses tracked the shooting
 * columns read made-attempted, without them they are makes only. The turnover
 * column only appears if turnovers can actually be logged, so nobody is shown a
 * permanently-zero statistic the way v1 did.
 */
function BoxTable({
  league,
  gameId,
  teamId,
}: {
  league: League;
  gameId: string;
  teamId: string;
}): React.JSX.Element {
  const box = teamBoxScore(league, gameId, teamId);
  const misses = showsAttempts(league);

  const cols: { key: string; width: number; of: (l: StatLine) => string }[] = [
    { key: 'PTS', width: 44, of: (l) => String(l.pts) },
    misses
      ? { key: 'FG', width: 58, of: (l) => `${l.fgm}-${l.fga}` }
      : { key: 'FGM', width: 48, of: (l) => String(l.fgm) },
    misses
      ? { key: '3P', width: 52, of: (l) => `${l.tpm}-${l.tpa}` }
      : { key: '3PM', width: 48, of: (l) => String(l.tpm) },
    misses
      ? { key: 'FT', width: 52, of: (l) => `${l.ftm}-${l.fta}` }
      : { key: 'FTM', width: 48, of: (l) => String(l.ftm) },
    { key: 'REB', width: 42, of: (l) => String(l.reb) },
    { key: 'AST', width: 40, of: (l) => String(l.ast) },
    { key: 'STL', width: 40, of: (l) => String(l.stl) },
    { key: 'BLK', width: 40, of: (l) => String(l.blk) },
    ...(showsTurnovers(league)
      ? [{ key: 'TO', width: 38, of: (l: StatLine) => String(l.tov) }]
      : []),
    { key: 'PF', width: 36, of: (l) => String(l.pf) },
  ];

  return (
    <Card>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          <View style={{ flexDirection: 'row' }}>
            <Cell width={124} align="flex-start">
              <Txt k="label">Player</Txt>
            </Cell>
            {cols.map((c) => (
              <Cell key={c.key} width={c.width}>
                <Txt k="label">{c.key}</Txt>
              </Cell>
            ))}
          </View>

          {box.rows.map((row) => {
            const player = league.players.find((p) => p.id === row.playerId);
            return (
              <View
                key={row.playerId ?? 'team-level'}
                style={{ flexDirection: 'row', marginTop: space(2.5) }}
              >
                <Cell width={124} align="flex-start">
                  <Txt numberOfLines={1}>{player?.name ?? 'Team'}</Txt>
                </Cell>
                {cols.map((c) => (
                  <Cell key={c.key} width={c.width}>
                    <Txt k="stat" color={c.key === 'PTS' ? colors.accent : colors.text}>
                      {c.of(row.line)}
                    </Txt>
                  </Cell>
                ))}
              </View>
            );
          })}

          <View
            style={{
              flexDirection: 'row',
              marginTop: space(3),
              paddingTop: space(3),
              borderTopWidth: 2,
              borderTopColor: colors.line,
            }}
          >
            <Cell width={124} align="flex-start">
              <Txt>Team{misses ? ` - ${pct(box.total.fgm, box.total.fga)} FG` : ''}</Txt>
            </Cell>
            {cols.map((c) => (
              <Cell key={c.key} width={c.width}>
                <Txt k="stat" color={c.key === 'PTS' ? colors.accent : colors.text}>
                  {c.of(box.total)}
                </Txt>
              </Cell>
            ))}
          </View>
        </View>
      </ScrollView>
    </Card>
  );
}

function Cell({
  width,
  children,
  align = 'center',
}: {
  width: number;
  children?: React.ReactNode;
  align?: 'center' | 'flex-start';
}): React.JSX.Element {
  return <View style={{ width, alignItems: align, justifyContent: 'center' }}>{children}</View>;
}
