/**
 * The Phase 1 walking skeleton. THROWAWAY: it exists to prove the architecture
 * end to end and will be replaced entirely in Phase 2 by the real screens.
 *
 * It deliberately shows the plumbing rather than hiding it, because the point
 * of this phase is to make the sync behaviour observable: what is pending, what
 * was refused, and whether the score the scorekeeper sees matches the ledger.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { gameScore, teamBoxScore, uid, type Action } from '@itala/domain';
import { colors, radius, space, statColors } from '../theme.js';
import { useStore } from '../store/StoreProvider.js';
import { useAdmin } from '../store/AdminProvider.js';

export function SkeletonScreen(): React.JSX.Element {
  const { state, ready, status, dispatch, reconcile } = useStore();
  const { isAdmin, busy, unlock, lock } = useAdmin();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const league = state.leagues[0];
  const game = league?.games[0];
  const score = useMemo(
    () => (league && game ? gameScore(league, game) : { home: 0, away: 0 }),
    [league, game],
  );

  const seed = useCallback(async () => {
    const now = Date.now();
    const lg = uid(now);
    const tA = uid(now);
    const tB = uid(now);
    const p1 = uid(now);
    const p2 = uid(now);
    const g = uid(now);
    const script: Action[] = [
      { t: 'ADD_LEAGUE', id: lg, now, name: 'Skeleton League', season: 'Phase 1' },
      { t: 'ADD_TEAM', id: tA, leagueId: lg, name: 'Riptide' },
      { t: 'ADD_TEAM', id: tB, leagueId: lg, name: 'Coastal' },
      { t: 'ADD_PLAYER', id: p1, leagueId: lg, teamId: tA, name: 'Ana', number: '7' },
      { t: 'ADD_PLAYER', id: p2, leagueId: lg, teamId: tB, name: 'Dee', number: '11' },
      { t: 'CREATE_GAME', id: g, now, leagueId: lg, homeTeamId: tA, awayTeamId: tB },
      { t: 'SET_LINEUP', leagueId: lg, gameId: g, side: 'home', playerIds: [p1] },
      { t: 'SET_LINEUP', leagueId: lg, gameId: g, side: 'away', playerIds: [p2] },
    ];
    for (const a of script) await dispatch(a);
  }, [dispatch]);

  const logStat = useCallback(
    async (side: 'home' | 'away', type: 'fg2_make' | 'fg3_make' | 'pf') => {
      if (!league || !game) return;
      const teamId = side === 'home' ? game.homeTeamId : game.awayTeamId;
      const onCourt = side === 'home' ? game.homeOnCourt : game.awayOnCourt;
      await dispatch({
        t: 'ADD_EVENT',
        id: uid(),
        now: Date.now(),
        leagueId: league.id,
        gameId: game.id,
        teamId,
        playerId: onCourt[0] ?? null,
        type,
        period: game.period,
      });
    },
    [dispatch, league, game],
  );

  if (!ready) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center' }}>
        <ActivityIndicator color={colors.accent} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: space(4), gap: space(3) }}>
        <Text style={{ color: colors.text, fontSize: 26, fontWeight: '700' }}>
          iTala <Text style={{ color: colors.muted, fontSize: 14 }}>walking skeleton</Text>
        </Text>

        <SyncBanner status={status} onRetry={() => void reconcile()} />

        {!isAdmin ? (
          <View style={card}>
            <Label>Admin</Label>
            <TextInput
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholder="Admin password"
              placeholderTextColor={colors.muted}
              accessibilityLabel="Admin password"
              style={{
                backgroundColor: colors.bg,
                borderColor: error ? colors.red : colors.line,
                borderWidth: 1,
                borderRadius: radius.md,
                color: colors.text,
                padding: space(3),
                marginTop: space(2),
              }}
            />
            {error ? <Text style={{ color: colors.red, marginTop: space(2) }}>{error}</Text> : null}
            <Btn
              label={busy ? 'Unlocking...' : 'Unlock'}
              disabled={busy}
              onPress={async () => {
                const r = await unlock(password);
                setError(r.ok ? null : r.message);
                if (r.ok) setPassword('');
              }}
            />
          </View>
        ) : (
          <View style={card}>
            <Text style={{ color: colors.accent }}>ADMIN MODE - stat tracking unlocked</Text>
            <Btn label="Lock" tone="ghost" onPress={() => void lock()} />
          </View>
        )}

        {!league ? (
          <View style={card}>
            <Label>No data yet</Label>
            <Btn label="Create a league, two teams and a game" onPress={() => void seed()} />
          </View>
        ) : (
          <>
            <View style={card}>
              <Label>{league.name}</Label>
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  marginTop: space(2),
                }}
              >
                <Score name={league.teams[0]?.name ?? 'Home'} value={score.home} />
                <Score name={league.teams[1]?.name ?? 'Away'} value={score.away} />
              </View>
              <Text style={{ color: colors.muted, marginTop: space(2), fontSize: 12 }}>
                Derived from {league.events.length} event
                {league.events.length === 1 ? '' : 's'}. Nothing numeric is stored.
              </Text>
            </View>

            <View style={card}>
              <Label>Log a stat</Label>
              <View style={{ flexDirection: 'row', gap: space(2), marginTop: space(2) }}>
                <Btn
                  label="+2 home"
                  fill={statColors.make}
                  onPress={() => void logStat('home', 'fg2_make')}
                />
                <Btn
                  label="+3 home"
                  fill={statColors.make}
                  onPress={() => void logStat('home', 'fg3_make')}
                />
                <Btn
                  label="+2 away"
                  fill={statColors.make}
                  onPress={() => void logStat('away', 'fg2_make')}
                />
              </View>
              <View style={{ flexDirection: 'row', gap: space(2), marginTop: space(2) }}>
                <Btn
                  label="Foul home"
                  fill={statColors.foul}
                  onPress={() => void logStat('home', 'pf')}
                />
                <Btn
                  label="Undo"
                  tone="ghost"
                  disabled={league.events.length === 0}
                  onPress={() =>
                    void dispatch({ t: 'UNDO_EVENT', leagueId: league.id, gameId: game?.id ?? '' })
                  }
                />
              </View>
            </View>

            <View style={card}>
              <Label>Box score, home</Label>
              {game
                ? teamBoxScore(league, game.id, game.homeTeamId).rows.map((r) => (
                    <Text
                      key={r.playerId ?? 'team'}
                      style={{ color: colors.text, marginTop: space(1) }}
                    >
                      {league.players.find((p) => p.id === r.playerId)?.name ?? 'Team'} {'  '}
                      <Text style={{ color: colors.accent }}>{r.line.pts} pts</Text>
                      <Text style={{ color: colors.muted }}>
                        {'  '}
                        {r.line.fgm}-{r.line.fga} FG {'  '}
                        {r.line.pf} PF
                      </Text>
                    </Text>
                  ))
                : null}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const card = {
  backgroundColor: colors.surface,
  borderColor: colors.line,
  borderWidth: 1,
  borderRadius: radius.lg,
  padding: space(4),
} as const;

function Label({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Text
      style={{ color: colors.muted, fontSize: 12, letterSpacing: 0.4, textTransform: 'uppercase' }}
    >
      {children}
    </Text>
  );
}

function Score({ name, value }: { name: string; value: number }): React.JSX.Element {
  return (
    <View>
      <Text style={{ color: colors.muted, fontSize: 12 }}>{name}</Text>
      <Text style={{ color: colors.text, fontSize: 40, fontWeight: '800' }}>{value}</Text>
    </View>
  );
}

function Btn({
  label,
  onPress,
  disabled,
  tone = 'primary',
  fill,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'ghost';
  fill?: string;
}): React.JSX.Element {
  const background = fill ?? (tone === 'ghost' ? 'transparent' : colors.accent);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={{
        backgroundColor: background,
        borderColor: colors.line,
        borderWidth: tone === 'ghost' ? 1 : 0,
        borderRadius: radius.md,
        paddingVertical: space(3),
        paddingHorizontal: space(4),
        marginTop: space(2),
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Text
        style={{
          color: tone === 'ghost' ? colors.text : statColors.onText,
          fontWeight: '700',
          textAlign: 'center',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The single most important thing on this screen. v1 could drop every write
 * silently and still look completely normal.
 */
function SyncBanner({
  status,
  onRetry,
}: {
  status: { enabled: boolean; pending: number; rejected: number; stalled: boolean };
  onRetry: () => void;
}): React.JSX.Element {
  if (!status.enabled) {
    return (
      <View style={[card, { borderColor: colors.line }]}>
        <Text style={{ color: colors.muted }}>Local-only. Data stays on this device.</Text>
      </View>
    );
  }
  if (status.rejected > 0) {
    return (
      <View style={[card, { borderColor: colors.red, backgroundColor: colors.redDim }]}>
        <Text style={{ color: colors.red }}>
          {status.rejected} change{status.rejected === 1 ? '' : 's'} could not be saved. Unlock
          admin and try again.
        </Text>
      </View>
    );
  }
  if (status.pending > 0) {
    return (
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel="Retry syncing now"
      >
        <View style={[card, { borderColor: colors.yellow }]}>
          <Text style={{ color: colors.yellow }}>
            {status.pending} change{status.pending === 1 ? '' : 's'} not synced
            {status.stalled ? ' - waiting for a connection' : ' - sending'}.
          </Text>
        </View>
      </Pressable>
    );
  }
  return (
    <View style={[card, { borderColor: colors.line }]}>
      <Text style={{ color: colors.green }}>All changes synced.</Text>
    </View>
  );
}
