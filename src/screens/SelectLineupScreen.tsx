import React, { useState, useEffect } from 'react';
import { View, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { Screen, Txt, Card, Button, TeamBadge } from '../components/ui';
import { useStore, useLeague } from '../store/StoreProvider';
import { colors, space, radius, LINEUP_SIZE } from '../theme';
import { ScreenProps } from '../navigation';
import { Team, Player } from '../types';

export default function SelectLineupScreen({ route, navigation }: ScreenProps<'SelectLineup'>) {
  const { leagueId, gameId, pending } = route.params;
  const { dispatch } = useStore();
  const league = useLeague(leagueId);
  const game = league?.games.find(g => g.id === gameId);
  // Either the game row already exists (the drop-in flow creates it with its
  // teams in one transaction) or it does not exist yet and `pending` names the
  // two teams it will be created from when Tip off is pressed.
  const homeTeamId = game?.homeTeamId ?? pending?.homeTeamId;
  const awayTeamId = game?.awayTeamId ?? pending?.awayTeamId;
  const homeTeam = league?.teams.find(t => t.id === homeTeamId);
  const awayTeam = league?.teams.find(t => t.id === awayTeamId);

  // ALL hooks run unconditionally, before any early return (React rules).
  const [waited, setWaited] = useState(false);
  // Lazy initial state seeds the first five synchronously on first render when
  // teams are already present (the common league-flow case), so the defaults
  // are correct immediately without waiting for an effect tick.
  const [home, setHome] = useState<string[]>(() =>
    homeTeam && !homeTeam.teamOnly ? homeTeam.playerIds.slice(0, LINEUP_SIZE) : []);
  const [away, setAway] = useState<string[]>(() =>
    awayTeam && !awayTeam.teamOnly ? awayTeam.playerIds.slice(0, LINEUP_SIZE) : []);
  const seededRef = React.useRef(!!(homeTeam && awayTeam));

  // Give the store a beat before admitting defeat: in the drop-in flow the game
  // row and its team rows land a tick after this screen mounts. The timer has
  // to cover the TEAMS gate below as well as the game one - it only watched
  // `game`, so a game whose teams never arrived showed the spinner for ever
  // rather than the "Teams not found" line it has.
  const resolved = !!(game || pending) && !!homeTeam && !!awayTeam;
  useEffect(() => {
    if (resolved) return;
    const t = setTimeout(() => setWaited(true), 1500);
    return () => clearTimeout(t);
  }, [resolved]);

  // Fallback seed for the rec flow where teams may arrive a beat after mount:
  // populate once, the first render where both teams exist.
  useEffect(() => {
    if (seededRef.current || !homeTeam || !awayTeam) return;
    seededRef.current = true;
    setHome(homeTeam.teamOnly ? [] : homeTeam.playerIds.slice(0, LINEUP_SIZE));
    setAway(awayTeam.teamOnly ? [] : awayTeam.playerIds.slice(0, LINEUP_SIZE));
  }, [homeTeam, awayTeam]);

  // Both gates below used to be dead ends: a line of text and no control, so a
  // user who landed on one could only kill the app. LiveGameScreen already
  // pairs its equivalent message with a way out; do the same here.
  const giveUp = (message: string) => (
    <Screen>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space(6), gap: space(3) }}>
        {waited ? (
          <>
            <Txt k="body" color={colors.muted} style={{ textAlign: 'center' }}>{message}</Txt>
            <Button title="Back to league" kind="ghost"
              onPress={() => navigation.replace('LeagueDetail', { leagueId })} />
          </>
        ) : <ActivityIndicator color={colors.brandTeal} size="large" />}
      </View>
    </Screen>
  );

  if (!league || (!game && !pending)) return giveUp('Game not found.');

  // The game row can arrive a beat before its team rows during a fresh rec
  // creation. Don't dereference teams until both exist.
  if (!homeTeam || !awayTeam) {
    // With `pending` there is no game yet, so "for this game" would send the
    // user looking for something that was never saved.
    return giveUp(pending
      ? 'Those teams are no longer in this league.'
      : 'Teams not found for this game.');
  }

  const ready =
    (homeTeam.teamOnly || home.length > 0) && (awayTeam.teamOnly || away.length > 0);

  // A disabled button with no reason next to it is the whole complaint: a team
  // with an empty roster can NEVER satisfy `ready`, so the user is left tapping
  // a dead control with the explanation ("No players on this team yet")
  // scrolled off the top. Name the teams that are blocking, and say whether the
  // fix is picking someone or adding someone.
  const blocking = [homeTeam, awayTeam].filter(t => !t.teamOnly &&
    (t === homeTeam ? home : away).length === 0);
  const blockingNames = blocking.map(t => t.name).join(' and ');
  const needsRoster = blocking.some(t => t.playerIds.length === 0);

  const start = () => {
    const homeIds = homeTeam.teamOnly ? [] : home;
    const awayIds = awayTeam.teamOnly ? [] : away;
    if (game) {
      // One combined write so a realtime echo can't land between two separate
      // dispatches and clear the away side (the "away lineup not set" bug).
      dispatch({ t: 'SET_LINEUPS', leagueId, gameId, home: homeIds, away: awayIds });
    } else {
      // Tip off IS the creation. Same single-write reasoning as SET_LINEUPS:
      // CREATE_GAME already carries both starting fives, so the game reaches
      // state, disk and the server complete rather than in two steps.
      dispatch({
        t: 'CREATE_GAME', id: gameId, leagueId,
        homeTeamId: homeTeam.id, awayTeamId: awayTeam.id,
        location: pending?.location,
        homeOnCourt: homeIds, awayOnCourt: awayIds,
      });
    }
    navigation.replace('LiveGame', { leagueId, gameId, spectator: false });
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space(4), paddingBottom: space(28) }}>
        <Txt k="h1" style={{ marginBottom: 4 }}>Starting Lineups</Txt>
        <Txt k="body" color={colors.muted} style={{ marginBottom: space(4) }}>
          Pick the {LINEUP_SIZE} players starting on court for each team. You can sub anytime during the game.
        </Txt>

        <TeamLineup team={homeTeam} players={league.players} selected={home} onChange={setHome} />
        <View style={{ height: space(3) }} />
        <TeamLineup team={awayTeam} players={league.players} selected={away} onChange={setAway} />
      </ScrollView>

      <View style={{ position: 'absolute', left: space(4), right: space(4), bottom: space(6) }}>
        {/* Above the button, so it comes first in reading order and a screen
            reader reaches it before the dimmed control it explains. */}
        {!ready && blockingNames ? (
          <Txt k="body" color={colors.muted}
            style={{ marginBottom: 8, textAlign: 'center', fontSize: 13 }}>
            {needsRoster
              ? `Add at least one player to ${blockingNames} to start.`
              : `Pick at least one player for ${blockingNames}.`}
          </Txt>
        ) : null}
        <Button title="Tip off  ▶" onPress={start} disabled={!ready} />
      </View>
    </Screen>
  );
}

function TeamLineup({ team, players, selected, onChange }:
  { team: Team; players: Player[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const roster = team.playerIds.map(id => players.find(p => p.id === id)).filter(Boolean) as Player[];
  const target = Math.min(LINEUP_SIZE, roster.length);

  const toggle = (pid: string) =>
    onChange(selected.includes(pid)
      ? selected.filter(x => x !== pid)
      : (selected.length >= LINEUP_SIZE ? selected : [...selected, pid]));

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: space(2) }}>
        <TeamBadge logo={team.logo} color={team.color} size={18} />
        <Txt k="h2" style={{ flex: 1 }}>{team.name}</Txt>
        {/* `target` is 0 for a team with no roster, so a bare
            `selected.length === target` painted an empty team's 0/0 GREEN -
            the color this screen uses for "this side is ready" - directly
            above a Tip off button that could never enable. Green has to mean
            ready, so it needs a player to be ready with. */}
        {!team.teamOnly && <Txt k="stat" color={target > 0 && selected.length === target ? colors.green : colors.muted}>{selected.length}/{target}</Txt>}
      </View>

      {team.teamOnly ? (
        <Txt k="body" color={colors.muted}>Opponent tracked at team level — no lineup needed.</Txt>
      ) : roster.length === 0 ? (
        <Txt k="body" color={colors.muted}>No players on this team yet.</Txt>
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {roster.map(p => {
            const sel = selected.includes(p.id);
            return (
              <Pressable key={p.id} onPress={() => toggle(p.id)}
                style={{ paddingVertical: 12, paddingHorizontal: 14, borderRadius: radius.md, borderWidth: 1.5, borderColor: sel ? team.color : colors.line, backgroundColor: sel ? team.color : colors.surface }}>
                <Txt k="body" color={sel ? '#FFFFFF' : colors.text}>{p.number ? `#${p.number} ` : ''}{p.name}</Txt>
              </Pressable>
            );
          })}
        </View>
      )}
    </Card>
  );
}
