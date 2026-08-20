import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  LINEUP_SIZE,
  MAX_PERIOD,
  NO_ONE_OUT,
  foulLimit,
  fouledOutSet,
  gameScore,
  periodLabel,
  playerFouls,
  teamBoxScore,
  statPad,
  teamPeriodFouls,
  uid,
  type EventType,
  type Game,
  type League,
  type Player,
  type Side,
  type Team,
} from '@itala/domain';
import {
  Button,
  Card,
  Empty,
  Icon,
  LivePip,
  Screen,
  Segmented,
  Sheet,
  TeamBadge,
  Txt,
} from '../ui/index';
import { colors, radius, space, statColors } from '../theme';
import { useLayout } from '../ui/useLayout';
import { useStore } from '../store/StoreProvider';
import { useAdmin } from '../store/AdminProvider';
import { SyncBanner } from '../components/SyncBanner';
import type { RootStackParams } from '../navigation';

type Props = NativeStackScreenProps<RootStackParams, 'LiveGame'>;

/** The stat pad. Label is what the status line says; short is on the button. */
interface PadButton {
  type: EventType;
  short: string;
  label: string;
  color: string;
}

/**
 * Presentation only. WHICH buttons appear is decided by statPad() in the
 * domain, so the rule lives in one tested place instead of in a screen.
 */
const BUTTONS: Record<EventType, PadButton> = {
  fg2_make: { type: 'fg2_make', short: '2PT', label: '+2', color: statColors.make },
  fg3_make: { type: 'fg3_make', short: '3PT', label: '+3', color: statColors.make },
  ft_make: { type: 'ft_make', short: 'FT', label: '+1 FT', color: statColors.make },
  fg2_miss: { type: 'fg2_miss', short: '2PT miss', label: '2PT miss', color: statColors.miss },
  fg3_miss: { type: 'fg3_miss', short: '3PT miss', label: '3PT miss', color: statColors.miss },
  ft_miss: { type: 'ft_miss', short: 'FT miss', label: 'FT miss', color: statColors.miss },
  reb: { type: 'reb', short: 'REB', label: 'Rebound', color: statColors.reb },
  ast: { type: 'ast', short: 'AST', label: 'Assist', color: statColors.ast },
  stl: { type: 'stl', short: 'STL', label: 'Steal', color: statColors.stl },
  blk: { type: 'blk', short: 'BLK', label: 'Block', color: statColors.blk },
  tov: { type: 'tov', short: 'TOV', label: 'Turnover', color: statColors.tov },
  pf: { type: 'pf', short: 'FOUL', label: 'Foul', color: statColors.foul },
  timeout: { type: 'timeout', short: 'TO', label: 'Timeout', color: colors.yellow },
};

export function LiveGameScreen({ route, navigation }: Props): React.JSX.Element {
  const { state, dispatch } = useStore();
  const { isAdmin } = useAdmin();
  const layout = useLayout();

  const league = state.leagues.find((l) => l.id === route.params.leagueId);
  const game = league?.games.find((g) => g.id === route.params.gameId);

  const [armed, setArmed] = useState<PadButton | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [activeSide, setActiveSide] = useState<Side>('home');
  const [subsFor, setSubsFor] = useState<Side | null>(null);

  const readOnly = route.params.spectator === true || !isAdmin;

  const score = useMemo(
    () => (league && game ? gameScore(league, game) : { home: 0, away: 0 }),
    [league, game],
  );

  const log = useCallback(
    async (side: Side, playerId: string | null) => {
      if (!league || !game || !armed || readOnly) return;
      const teamId = side === 'home' ? game.homeTeamId : game.awayTeamId;

      // Warn BEFORE dispatching, so the scorekeeper is told at the moment it
      // happens rather than discovering it when the row vanishes.
      if (armed.type === 'pf' && playerId) {
        const limit = foulLimit(league);
        if (playerFouls(league, game.id, playerId) + 1 >= limit) {
          const name = league.players.find((p) => p.id === playerId)?.name ?? 'Player';
          Alert.alert(
            'Fouled out',
            `${name} reached ${limit} fouls and was taken off the court. Tap Subs to bring someone in.`,
          );
        }
      }

      await dispatch({
        t: 'ADD_EVENT',
        id: uid(),
        now: Date.now(),
        leagueId: league.id,
        gameId: game.id,
        teamId,
        playerId,
        type: armed.type,
        period: game.period,
      });

      const who = playerId
        ? (league.players.find((p) => p.id === playerId)?.name ?? 'Player')
        : 'Team';
      setFlash(`${armed.label} - ${who}`);
      // ALWAYS clear the armed stat after logging. Every stat needs a fresh
      // arm; there is no repeat mode, and that is what stops double-logging.
      setArmed(null);
    },
    [league, game, armed, readOnly, dispatch],
  );

  if (!league || !game)
    return (
      <Screen scroll>
        <Empty title="Game not found." />
      </Screen>
    );

  const home = league.teams.find((t) => t.id === game.homeTeamId);
  const away = league.teams.find((t) => t.id === game.awayTeamId);
  if (!home || !away) {
    return (
      <Screen scroll>
        <Empty
          title="This game is missing a team."
          subtitle="It cannot be opened. The team it referenced no longer exists."
        />
      </Screen>
    );
  }

  const pad: PadButton[] = statPad(league).map((t) => BUTTONS[t]);

  const changePeriod = (delta: number): void => {
    const next = game.period + delta;
    if (next < 1 || next > MAX_PERIOD) return;
    Alert.alert(
      delta > 0 ? 'Advance period?' : 'Go back a period?',
      delta > 0
        ? `Move from period ${game.period} to ${next}? Team fouls reset each period.`
        : `Move from period ${game.period} to ${next}? Team fouls are tracked per period.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: `Go to ${next}`,
          onPress: () =>
            void dispatch({ t: 'SET_PERIOD', leagueId: league.id, gameId: game.id, period: next }),
        },
      ],
    );
  };

  const finish = (): void => {
    const level = score.home === score.away;
    Alert.alert(
      level ? 'Scores are level' : 'Finish game?',
      level
        ? `${home.name} ${score.home}, ${away.name} ${score.away}. Basketball goes to overtime rather than ending level. Add a period, or finish anyway and it will be recorded as a draw.`
        : 'This locks the final score and updates standings. You can still edit the box score after.',
      level
        ? [
            {
              text: 'Add a period',
              onPress: () =>
                void dispatch({
                  t: 'SET_PERIOD',
                  leagueId: league.id,
                  gameId: game.id,
                  period: game.period + 1,
                }),
            },
            { text: 'Cancel', style: 'cancel' },
            { text: 'Finish anyway', style: 'destructive', onPress: doFinish },
          ]
        : [
            { text: 'Keep playing', style: 'cancel' },
            { text: 'Finish', style: 'destructive', onPress: doFinish },
          ],
    );
  };

  function doFinish(): void {
    if (!league || !game) return;
    void dispatch({
      t: 'SET_GAME_STATUS',
      leagueId: league.id,
      gameId: game.id,
      now: Date.now(),
      status: 'final',
    }).then(() => navigation.replace('BoxScore', { leagueId: league.id, gameId: game.id }));
  }

  const statusLine = readOnly
    ? 'Spectator, read only.'
    : armed
      ? layout.wide
        ? `${armed.label} - tap any player`
        : `${armed.label} - tap a ${(activeSide === 'home' ? home : away).name} player`
      : flash
        ? flash
        : 'Pick a stat, then tap a player';

  const rosterFor = (side: Side): { team: Team; onCourt: string[] } => ({
    team: side === 'home' ? home : away,
    onCourt: side === 'home' ? game.homeOnCourt : game.awayOnCourt,
  });

  return (
    <Screen>
      <View style={{ paddingHorizontal: space(4), paddingTop: space(2) }}>
        <SyncBanner />
      </View>

      {/* Scoreboard */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          paddingHorizontal: space(4),
          gap: space(2),
        }}
      >
        <SidePanel
          league={league}
          game={game}
          team={home}
          score={score.home}
          active={layout.wide || activeSide === 'home'}
          onPress={() => setActiveSide('home')}
        />
        <View style={{ alignItems: 'center', width: 84 }}>
          <LivePip />
          <Txt k="label" style={{ marginTop: space(1) }}>
            {periodLabel(league, game.period)}
          </Txt>
          {readOnly ? null : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2) }}>
              <PeriodBtn dir={-1} disabled={game.period <= 1} onPress={() => changePeriod(-1)} />
              <Txt k="h1">{game.period}</Txt>
              <PeriodBtn
                dir={1}
                disabled={game.period >= MAX_PERIOD}
                onPress={() => changePeriod(1)}
              />
            </View>
          )}
        </View>
        <SidePanel
          league={league}
          game={game}
          team={away}
          score={score.away}
          active={layout.wide || activeSide === 'away'}
          onPress={() => setActiveSide('away')}
        />
      </View>

      {/* Controls */}
      {readOnly ? null : (
        <View
          style={{
            flexDirection: 'row',
            gap: space(2),
            padding: space(4),
            paddingBottom: space(2),
          }}
        >
          <Button
            title="Undo"
            kind="ghost"
            icon="undo"
            disabled={league.events.filter((e) => e.gameId === game.id).length === 0}
            onPress={() => {
              setFlash(null);
              void dispatch({ t: 'UNDO_EVENT', leagueId: league.id, gameId: game.id });
            }}
            style={{ flex: 1 }}
          />
          <Button
            title="Subs"
            kind="ghost"
            icon="subs"
            onPress={() => setSubsFor(layout.wide ? 'home' : activeSide)}
            style={{ flex: 1 }}
          />
        </View>
      )}

      {/* Status line */}
      <View style={{ paddingHorizontal: space(4), paddingVertical: space(2) }}>
        <Txt color={armed ? colors.accent : flash ? colors.green : colors.muted}>{statusLine}</Txt>
      </View>

      {/* Court */}
      <View
        style={{
          flex: 1,
          flexDirection: layout.wide ? 'row' : 'column',
          paddingHorizontal: space(4),
          gap: space(3),
        }}
      >
        {(layout.wide ? (['home', 'away'] as const) : ([activeSide] as const)).map((side) => {
          const { team, onCourt } = rosterFor(side);
          return (
            <Court
              key={side}
              league={league}
              game={game}
              team={team}
              onCourt={onCourt}
              armed={Boolean(armed)}
              readOnly={readOnly}
              showHeader={layout.wide}
              onPressPlayer={(pid) => void log(side, pid)}
              onOpenSubs={() => setSubsFor(side)}
            />
          );
        })}
      </View>

      {/* Stat pad */}
      {readOnly ? (
        <View style={{ padding: space(4) }}>
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2) }}>
              <Icon name="eye" color={colors.muted} />
              <Txt color={colors.muted}>Watching live. Scores update automatically.</Txt>
            </View>
          </Card>
        </View>
      ) : (
        <View style={{ padding: space(4), gap: space(2) }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
            {pad.map((b) => {
              const on = armed?.type === b.type;
              return (
                <Pressable
                  key={b.type}
                  onPress={() => setArmed(on ? null : b)}
                  accessibilityRole="button"
                  accessibilityLabel={b.label}
                  accessibilityState={{ selected: on }}
                  accessibilityHint="Then tap a player to log it"
                  style={{
                    flexGrow: 1,
                    flexBasis: '30%',
                    backgroundColor: on ? b.color : colors.surface,
                    borderWidth: 1,
                    borderColor: on ? b.color : colors.line,
                    borderRadius: radius.md,
                    paddingVertical: space(3.5),
                    alignItems: 'center',
                  }}
                >
                  <Txt k="stat" color={on ? statColors.onText : b.color}>
                    {b.short}
                  </Txt>
                </Pressable>
              );
            })}
          </View>
          <Button title="FINISH GAME" kind="danger" onPress={finish} />
        </View>
      )}

      <SubsSheet
        league={league}
        game={game}
        side={subsFor}
        onClose={() => setSubsFor(null)}
        onSubstitute={(side, outId, inId) =>
          void dispatch({
            t: 'SUBSTITUTE',
            leagueId: league.id,
            gameId: game.id,
            side,
            outId,
            inId,
          })
        }
      />
    </Screen>
  );
}

function PeriodBtn({
  dir,
  disabled,
  onPress,
}: {
  dir: 1 | -1;
  disabled: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={12}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={dir > 0 ? 'Advance period' : 'Go back a period'}
      accessibilityState={{ disabled }}
    >
      <Icon
        name={dir > 0 ? 'plus' : 'minus'}
        size={18}
        color={disabled ? colors.line : colors.accent}
      />
    </Pressable>
  );
}

function SidePanel({
  league,
  game,
  team,
  score,
  active,
  onPress,
}: {
  league: League;
  game: Game;
  team: Team;
  score: number;
  active: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const fouls = teamPeriodFouls(league, game.id, team.id, game.period);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${team.name}, ${score} points, ${fouls} team fouls this period`}
      accessibilityState={{ selected: active }}
      style={{ flex: 1 }}
    >
      <Txt k="label">Team fouls: {fouls}</Txt>
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), marginTop: space(1) }}
      >
        <TeamBadge color={team.color} logoUrl={team.logoUrl} size={12} />
        <Txt k="body" numberOfLines={1} style={{ flex: 1 }}>
          {team.name}
        </Txt>
      </View>
      <Txt k="display">{score}</Txt>
      <View
        style={{
          height: 3,
          borderRadius: 2,
          backgroundColor: active ? team.color : 'transparent',
          marginTop: space(1),
        }}
      />
    </Pressable>
  );
}

function Court({
  league,
  game,
  team,
  onCourt,
  armed,
  readOnly,
  showHeader,
  onPressPlayer,
  onOpenSubs,
}: {
  league: League;
  game: Game;
  team: Team;
  onCourt: string[];
  armed: boolean;
  readOnly: boolean;
  showHeader: boolean;
  onPressPlayer: (playerId: string) => void;
  onOpenSubs: () => void;
}): React.JSX.Element {
  const box = teamBoxScore(league, game.id, team.id);
  const limit = foulLimit(league);

  if (onCourt.length === 0) {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Txt color={colors.muted} style={{ textAlign: 'center' }}>
          No lineup set for {team.name}.
        </Txt>
        {readOnly ? null : (
          <Button
            title="Set starting five"
            kind="ghost"
            onPress={onOpenSubs}
            style={{ marginTop: space(3) }}
          />
        )}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, justifyContent: 'space-between', gap: space(2) }}>
      {showHeader ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2) }}>
          <TeamBadge color={team.color} logoUrl={team.logoUrl} size={10} />
          <Txt k="label">{team.name}</Txt>
        </View>
      ) : null}

      {onCourt.map((pid) => {
        const player = league.players.find((p) => p.id === pid);
        const line = box.rows.find((r) => r.playerId === pid)?.line;
        const fouls = line?.pf ?? 0;
        const danger = fouls >= limit - 1;
        return (
          <Pressable
            key={pid}
            onPress={() => onPressPlayer(pid)}
            disabled={readOnly || !armed}
            accessibilityRole="button"
            accessibilityLabel={`${player?.name ?? 'Player'}, ${line?.pts ?? 0} points, ${fouls} fouls`}
            accessibilityState={{ disabled: readOnly || !armed }}
            style={({ pressed }) => ({
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              gap: space(3),
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.line,
              borderRadius: radius.md,
              paddingHorizontal: space(3),
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <View
              style={{ width: 4, height: '55%', borderRadius: 2, backgroundColor: team.color }}
            />
            <Txt k="label" style={{ width: 32 }}>
              {player?.number ? `#${player.number}` : ''}
            </Txt>
            <Txt
              style={{ flex: 1 }}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.7}
              allowFontScaling={false}
            >
              {player?.name ?? 'Player'}
            </Txt>
            <Txt k="stat" color={colors.accent}>
              {line?.pts ?? 0}
            </Txt>
            <Txt
              k="label"
              color={danger ? colors.red : colors.muted}
              style={{ width: 44, textAlign: 'right' }}
            >
              {fouls} PF
            </Txt>
          </Pressable>
        );
      })}

      {onCourt.length < LINEUP_SIZE && !readOnly ? (
        <Pressable
          onPress={onOpenSubs}
          accessibilityRole="button"
          accessibilityLabel={`Add a player to court, ${onCourt.length} of ${LINEUP_SIZE}`}
          style={{
            flex: 1,
            borderWidth: 1,
            borderStyle: 'dashed',
            borderColor: colors.line,
            borderRadius: radius.md,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Txt color={colors.muted}>
            Add player to court ({onCourt.length}/{LINEUP_SIZE})
          </Txt>
        </Pressable>
      ) : null}
    </View>
  );
}

function SubsSheet({
  league,
  game,
  side,
  onClose,
  onSubstitute,
}: {
  league: League;
  game: Game;
  side: Side | null;
  onClose: () => void;
  onSubstitute: (side: Side, outId: string, inId: string) => void;
}): React.JSX.Element | null {
  const [mode, setMode] = useState(0);
  const [outId, setOutId] = useState<string | null>(null);

  if (!side) return null;

  const team = league.teams.find(
    (t) => t.id === (side === 'home' ? game.homeTeamId : game.awayTeamId),
  );
  if (!team) return null;

  const onCourt = side === 'home' ? game.homeOnCourt : game.awayOnCourt;
  const fouledOut = fouledOutSet(league, game.id, team.id);
  const bench = team.playerIds.filter((pid) => !onCourt.includes(pid));
  const nameOf = (pid: string): Player | undefined => league.players.find((p) => p.id === pid);

  const courtFull = onCourt.length >= LINEUP_SIZE;

  return (
    <Sheet visible title={`${team.name} substitutions`} onClose={onClose}>
      <Segmented
        label="Substitution mode"
        options={['Sub one', 'Set five']}
        value={mode}
        onChange={setMode}
      />
      <ScrollView style={{ maxHeight: 380, marginTop: space(3) }}>
        <Txt k="label">
          {courtFull
            ? '1. Tap who comes OUT'
            : `On court (${onCourt.length}/${LINEUP_SIZE}), tap to take OUT`}
        </Txt>
        <View
          style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginTop: space(2) }}
        >
          {onCourt.map((pid) => (
            <Chip
              key={pid}
              label={`${nameOf(pid)?.name ?? 'Player'} - ${playerFouls(league, game.id, pid)} PF`}
              selected={outId === pid}
              tone={colors.red}
              onPress={() => setOutId(outId === pid ? null : pid)}
            />
          ))}
        </View>

        <Txt k="label" style={{ marginTop: space(4) }}>
          {outId || !courtFull ? '2. Tap who comes IN' : '2. Select someone to take out first'}
        </Txt>
        <View
          style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginTop: space(2) }}
        >
          {bench.length === 0 ? (
            <Txt color={colors.muted}>No bench players available.</Txt>
          ) : (
            bench.map((pid) => {
              const out = fouledOut.has(pid);
              return (
                <Chip
                  key={pid}
                  label={`${nameOf(pid)?.name ?? 'Player'}${out ? ' - fouled out' : ''}`}
                  tone={colors.green}
                  disabled={out || (courtFull && !outId)}
                  onPress={() => {
                    onSubstitute(side, outId ?? NO_ONE_OUT, pid);
                    setOutId(null);
                    onClose();
                  }}
                />
              );
            })
          )}
        </View>
      </ScrollView>
    </Sheet>
  );
}

function Chip({
  label,
  onPress,
  selected,
  disabled,
  tone,
}: {
  label: string;
  onPress: () => void;
  selected?: boolean;
  disabled?: boolean;
  tone: string;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: Boolean(selected), disabled: Boolean(disabled) }}
      style={{
        paddingVertical: space(2.5),
        paddingHorizontal: space(3),
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: tone,
        backgroundColor: selected ? tone : 'transparent',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Txt color={selected ? colors.bg : colors.text}>{label}</Txt>
    </Pressable>
  );
}
