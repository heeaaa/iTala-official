import React, { useEffect, useState } from 'react';
import { View, Animated } from 'react-native';
import { Screen, Txt, Button, TeamBadge, PromoStrip } from '../components/ui';
import { useLeague } from '../store/StoreProvider';
import { colors, space, radius, font } from '../theme';
import { ScreenProps } from '../navigation';
import { gameScore, teamBoxScore, perfRating, outcomeOf } from '../lib/stats';
import { usePromos, onPromoTap } from '../lib/usePromos';

// The emotional payoff at the buzzer. A brief, celebratory FINAL card —
// winner, score, and Player of the Game — before the user continues to the
// detailed box score. This is the moment players screenshot.
export default function FinalScoreScreen({ route, navigation }: ScreenProps<'FinalScore'>) {
  const { leagueId, gameId } = route.params;
  const league = useLeague(leagueId);
  const game = league?.games.find(g => g.id === gameId);
  const { activePromos } = usePromos();
  // Pick one promo once, and keep it for the life of the screen.
  //
  // This was a useMemo keyed on `activePromos.length`, which worked but lied to
  // the dependency linter: the whole point is NOT to re-derive when
  // `activePromos` changes identity, because a new pick mid-animation would swap
  // the sponsor out under the user. Expressing it as a lazily-filled ref says
  // that directly and needs no suppression - promos load asynchronously, so the
  // first render can legitimately see an empty list and fill in later (F-14).
  const promoPickRef = React.useRef<(typeof activePromos)[number] | null>(null);
  if (!promoPickRef.current && activePromos.length) {
    promoPickRef.current = activePromos[Math.floor(Math.random() * activePromos.length)];
  }
  const promoPick = promoPickRef.current;

  const fade = useState(new Animated.Value(0))[0];
  const pop = useState(new Animated.Value(0.9))[0];
  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 450, useNativeDriver: true }),
      Animated.spring(pop, { toValue: 1, friction: 6, useNativeDriver: true }),
    ]).start();
  }, [fade, pop]);

  if (!league || !game) return <Screen><Txt k="body">Game not found.</Txt></Screen>;

  const home = league.teams.find(t => t.id === game.homeTeamId);
  const away = league.teams.find(t => t.id === game.awayTeamId);
  const sc = gameScore(league, game);
  // `homeWon` was `sc.home >= sc.away`, which made a tie report as a home win.
  // Every consumer below happens to guard on `tie`, so the visible bug was
  // confined to Player of the Game - but the next consumer added would have
  // inherited it. Deciding the outcome once removes the trap.
  const outcome = outcomeOf(sc.home, sc.away);
  const tie = outcome === 'tie';
  const homeWon = outcome === 'home';
  const winner = homeWon ? home : away;
  const winnerScore = homeWon ? sc.home : sc.away;
  const loserScore = homeWon ? sc.away : sc.home;

  // Player of the Game: best composite line on the winning team, or across both
  // teams when the game is drawn.
  const potg = (() => {
    // On a tie there is no winning team, so both are eligible. Going through
    // `winner` here would quietly restrict Player of the Game to the home side,
    // since `winner` falls back to home when the scores are level.
    const teamIds = tie ? [game.homeTeamId, game.awayTeamId] : [winner?.id ?? ''];
    const pool = teamIds
      .flatMap(tid => teamBoxScore(league, gameId, tid).lines)
      .filter(l => l.playerId && perfRating(l) > 0);
    if (pool.length === 0) return null;
    const best = pool.sort((a, b) => perfRating(b) - perfRating(a))[0];
    const p = league.players.find(x => x.id === best.playerId);
    return p ? { name: p.name, line: best } : null;
  })();

  return (
    <Screen>
      <Animated.View style={{ flex: 1, opacity: fade, justifyContent: 'center', paddingHorizontal: space(5) }}>
        <Animated.View style={{ transform: [{ scale: pop }], alignItems: 'center' }}>
          <Txt k="label" color={colors.brandLime} style={{ letterSpacing: 3, fontSize: 13 }}>FINAL</Txt>

          {/* Score line */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: space(4) }}>
            <View style={{ alignItems: 'center', flex: 1 }}>
              <TeamBadge logo={home?.logo} color={home?.color ?? colors.muted} size={44} />
              <Txt k="body" numberOfLines={1} style={{ marginTop: 6, textAlign: 'center' }}>{home?.name}</Txt>
              <Txt color={homeWon && !tie ? colors.brandLime : colors.text} style={{ fontFamily: font.display, fontSize: 52, lineHeight: 60, includeFontPadding: false } as any}>{sc.home}</Txt>
            </View>
            <Txt k="h2" color={colors.muted}>—</Txt>
            <View style={{ alignItems: 'center', flex: 1 }}>
              <TeamBadge logo={away?.logo} color={away?.color ?? colors.muted} size={44} />
              <Txt k="body" numberOfLines={1} style={{ marginTop: 6, textAlign: 'center' }}>{away?.name}</Txt>
              <Txt color={!homeWon && !tie ? colors.brandLime : colors.text} style={{ fontFamily: font.display, fontSize: 52, lineHeight: 60, includeFontPadding: false } as any}>{sc.away}</Txt>
            </View>
          </View>

          {/* Winner line */}
          {!tie && winner ? (
            <Txt k="h2" style={{ marginTop: space(4), textAlign: 'center' }}>
              🏆 {winner.name} win{winnerScore - loserScore > 0 ? ` by ${winnerScore - loserScore}` : ''}
            </Txt>
          ) : (
            // Not "It's a tie!" - basketball has no draws, and the standings do
            // not record one. A game finished level has no result, so say that
            // plainly rather than announcing an outcome the record does not have.
            <View style={{ marginTop: space(4), alignItems: 'center' }}>
              <Txt k="h2">Level at the final buzzer</Txt>
              <Txt k="body" color={colors.muted} style={{ fontSize: 13, marginTop: 4, textAlign: 'center' }}>
                No result recorded — this game counts towards neither team&apos;s W-L.
              </Txt>
            </View>
          )}

          {/* Player of the Game */}
          {potg && (
            <View style={{ marginTop: space(4), alignSelf: 'stretch', backgroundColor: colors.accentDim, borderColor: colors.brandTeal, borderWidth: 1, borderRadius: radius.md, padding: 14, alignItems: 'center' }}>
              <Txt k="label" color={colors.brandTeal}>🏅 PLAYER OF THE GAME</Txt>
              <Txt k="h2" style={{ marginTop: 4 }}>{potg.name}</Txt>
              <Txt k="body" color={colors.muted} style={{ fontSize: 13, marginTop: 2 }}>
                {potg.line.pts} PTS · {potg.line.reb} REB · {potg.line.ast} AST{potg.line.stl ? ` · ${potg.line.stl} STL` : ''}{potg.line.blk ? ` · ${potg.line.blk} BLK` : ''}
              </Txt>
            </View>
          )}
        </Animated.View>
      </Animated.View>

      <View style={{ paddingHorizontal: space(4), paddingBottom: space(6), gap: 10 }}>
        {promoPick ? (
          <View style={{ marginBottom: space(2) }}>
            <PromoStrip promo={promoPick!} onPress={onPromoTap} />
          </View>
        ) : null}
        <Button title="View box score" onPress={() => navigation.replace('BoxScore', { leagueId, gameId })} />
      </View>
    </Screen>
  );
}
