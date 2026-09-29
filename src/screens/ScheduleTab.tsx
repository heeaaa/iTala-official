import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { Button, Card, Empty, Txt } from '../components/ui';
import { ScreenProps } from '../navigation';
import { colors, radius, space } from '../theme';
import { League } from '../types';
import {
  ConnectEventRef, ConnectSchedule, connectMobileGameId,
  getConnectSchedule, isConnectResult, listConnectEvents, nextScheduleDay, nowInZone,
} from '../sync/connectSchedule';

type Props = {
  league: League;
  canScore: boolean;
  navigation: ScreenProps<'LeagueDetail'>['navigation'];
};

const dateLabel = (day: string) => {
  const [year, month, date] = day.split('-').map(Number);
  return new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, date)));
};

const timeLabel = (time: string | null) => {
  if (!time) return 'Time TBC';
  const [hour, minute] = time.split(':').map(Number);
  const clock = (hour % 12) || 12;
  return `${clock}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
};

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ selected }} style={{ minHeight: 42, justifyContent: 'center', paddingHorizontal: 13,
      borderRadius: 12, borderWidth: 1, borderColor: selected ? colors.brandTeal : colors.line,
      backgroundColor: selected ? colors.accentDim : colors.surface }}>
    <Txt k="body" color={selected ? colors.brandTeal : colors.muted} style={{ fontSize: 12 }}>{label}</Txt>
  </Pressable>;
}

export default function ScheduleTab({ league, canScore, navigation }: Props) {
  const [events, setEvents] = useState<ConnectEventRef[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<ConnectSchedule | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [division, setDivision] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const sequence = useRef(0);

  const load = async (eventId?: string) => {
    const request = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const linked = await listConnectEvents(league.id);
      if (request !== sequence.current) return;
      setEvents(linked);
      const chosen = eventId && linked.some(e => e.id === eventId) ? eventId
        : selectedEvent && linked.some(e => e.id === selectedEvent) ? selectedEvent : linked[0]?.id;
      setSelectedEvent(chosen ?? null);
      if (!chosen) { setSchedule(null); setDay(null); return; }
      if (chosen !== schedule?.event.id) setSchedule(null);
      const result = await getConnectSchedule(league.id, chosen);
      if (request !== sequence.current) return;
      setSchedule(result);
      setDay(previous => chosen === selectedEvent && previous && result.games.some(g => g.day === previous)
        ? previous : nextScheduleDay(result.games, nowInZone(result.event.timezone)));
      setDivision(previous => chosen === selectedEvent && result.divisions.some(d => d.id === previous) ? previous : null);
    } catch (e) {
      if (request === sequence.current) setError((e as Error).message || 'Could not load the schedule.');
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // This component mounts only while its tab is open. A manual refresh keeps
    // filters in place without polling Connect on every league render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [league.id]);

  if (loading && (!schedule || selectedEvent !== schedule.event.id)) return <View style={{ padding: space(5), alignItems: 'center' }}>
    <ActivityIndicator color={colors.brandTeal} accessibilityLabel="Loading Connect schedule" />
    <Txt k="body" color={colors.muted} style={{ marginTop: 12 }}>Loading Connect fixtures…</Txt>
  </View>;

  if (error && !schedule) return <Card>
    <Txt k="body">{error}</Txt>
    <Button title="Try again" onPress={() => void load()} style={{ marginTop: space(3) }} />
  </Card>;

  if (!events.length) return <Empty title="No linked Connect event" subtitle="Published events linked to this league will appear here." />;

  if (!schedule) return null;
  const days = [...new Set(schedule.games.map(g => g.day).filter((d): d is string => !!d))].sort();
  const hasTbc = schedule.games.some(g => !g.day);
  const localNow = nowInZone(schedule.event.timezone);
  const visible = schedule.games.filter(g => (day === null ? !g.day : g.day === day) && (!division || g.divisionId === division))
    .sort((a, b) => (a.time ?? '').localeCompare(b.time ?? '') || (a.court ?? 0) - (b.court ?? 0) || a.id.localeCompare(b.id));
  const highlighted = visible.find(g => !isConnectResult(g) && g.day && g.time && `${g.day}T${g.time}` >= localNow)?.id;
  const teamById = new Map(schedule.teams.map(t => [t.id, t]));
  const divisionById = new Map(schedule.divisions.map(d => [d.id, d.name]));

  return <View>
    {events.length > 1 && <ScrollView horizontal showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingRight: 8 }} style={{ marginBottom: space(3), flexGrow: 0, flexShrink: 0 }}>
      {events.map(event => <Chip key={event.id} label={event.name} selected={selectedEvent === event.id}
        onPress={() => void load(event.id)} />)}
    </ScrollView>}

    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space(1) }}>
      <Txt k="body" color={colors.muted} style={{ flex: 1, fontSize: 12 }}>
        {events.length === 1 ? `${schedule.event.name} · ` : ''}Times in {schedule.event.timezone}
      </Txt>
      <Pressable onPress={() => void load()} accessibilityRole="button" accessibilityLabel="Refresh schedule"
        disabled={loading} style={{ padding: 8 }}>
        <Txt k="body" color={colors.brandTeal} style={{ fontSize: 12 }}>{loading ? 'Refreshing…' : 'Refresh'}</Txt>
      </Pressable>
    </View>
    {error ? <Txt k="body" color={colors.red} style={{ marginBottom: space(2) }}>{error}</Txt> : null}

    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, flexShrink: 0, marginBottom: space(2) }}
      contentContainerStyle={{ gap: 8, paddingRight: 8 }} accessibilityLabel="Schedule dates">
      {days.map(d => <Chip key={d} label={dateLabel(d)} selected={day === d} onPress={() => setDay(d)} />)}
      {hasTbc && <Chip label="Date TBC" selected={day === null} onPress={() => setDay(null)} />}
    </ScrollView>

    {schedule.divisions.length > 1 && <ScrollView horizontal showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, flexShrink: 0, marginBottom: space(3) }} contentContainerStyle={{ gap: 8, paddingRight: 8 }}>
      <Chip label="All divisions" selected={division === null} onPress={() => setDivision(null)} />
      {schedule.divisions.map(d => <Chip key={d.id} label={d.name} selected={division === d.id}
        onPress={() => setDivision(d.id)} />)}
    </ScrollView>}

    {visible.length === 0 ? <Empty title="No fixtures for this date" subtitle="Choose another date or division." /> :
      <>
        <Txt k="body" color={colors.muted} style={{ fontSize: 12, marginBottom: space(2) }}>
          {day ? dateLabel(day) : 'Date TBC'} · {visible.length} {visible.length === 1 ? 'game' : 'games'}
        </Txt>
        {visible.map(game => {
          const home = game.homeTeamId ? teamById.get(game.homeTeamId) : undefined;
          const away = game.awayTeamId ? teamById.get(game.awayTeamId) : undefined;
          const mobileHome = home?.mobileTeamId && league.teams.find(t => t.id === home.mobileTeamId);
          const mobileAway = away?.mobileTeamId && league.teams.find(t => t.id === away.mobileTeamId);
          // Older approved results keep their original mobile ID in Connect.
          // New Schedule starts use the deterministic fixture-based ID.
          const mobileGame = league.games.find(g => g.id === game.mobileGameId || g.id === connectMobileGameId(game.id));
          const final = game.score1 !== null && game.score2 !== null;
          const scored = isConnectResult(game);
          const canStart = canScore && !scored && !mobileGame && !!game.day && !!game.time
            && !!mobileHome && !!mobileAway && mobileHome.id !== mobileAway.id;
          const courtName = game.court ? schedule.event.courtNames[game.court - 1] || `Court ${game.court}` : 'Court TBC';
          const context = [timeLabel(game.time), courtName, schedule.divisions.length > 1 ? divisionById.get(game.divisionId) : null].filter(Boolean).join(' · ');
          const openMobile = () => {
            if (!mobileGame) return;
            if (mobileGame.status === 'final') navigation.navigate('BoxScore', { leagueId: league.id, gameId: mobileGame.id });
            else navigation.navigate('LiveGame', { leagueId: league.id, gameId: mobileGame.id, spectator: !canScore });
          };
          return <Card key={game.id} style={{ marginBottom: space(2), borderColor: highlighted === game.id ? colors.brandTeal : colors.line,
            borderWidth: 1, borderRadius: radius.md }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space(2) }}>
              <Txt k="body" color={colors.muted} style={{ flex: 1, fontSize: 12 }}>{context}</Txt>
              {highlighted === game.id && <Txt k="label" color={colors.brandTeal}>NEXT</Txt>}
            </View>
            {game.label ? <Txt k="body" color={colors.muted} style={{ fontSize: 11, marginBottom: 4 }}>{game.label}</Txt> : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Txt k="h2" numberOfLines={2} style={{ flex: 1 }}>{home?.name ?? 'TBD'}</Txt>
              {final ? <Txt k="stat" color={colors.brandTeal}>{game.score1}–{game.score2}</Txt>
                : <Txt k="body" color={colors.muted}>vs</Txt>}
              <Txt k="h2" numberOfLines={2} style={{ flex: 1, textAlign: 'right' }}>{away?.name ?? 'TBD'}</Txt>
            </View>
            {final ? <>
                <Txt k="body" color={colors.muted} style={{ marginTop: space(2), fontSize: 12 }}>
                  {game.mobileGameId ? 'Approved mobile result' : 'Final in Connect'}
                </Txt>
                {mobileGame?.status === 'final' && <Button title="View mobile box score" onPress={openMobile}
                  kind="ghost" style={{ marginTop: space(2) }} />}
              </> : scored ? <Txt k="body" color={colors.muted} style={{ marginTop: space(2), fontSize: 12 }}>Score entry in Connect</Txt>
              : mobileGame ? <Button title={mobileGame.status === 'final' ? 'View box score' : 'Open game'}
                  onPress={openMobile} kind="ghost" style={{ marginTop: space(3) }} />
              : canStart ? <Button title="Start game" onPress={() => navigation.navigate('SelectLineup', {
                  leagueId: league.id, gameId: connectMobileGameId(game.id),
                  pending: { homeTeamId: mobileHome!.id, awayTeamId: mobileAway!.id, location: courtName,
                    connect: { eventId: schedule.event.id, gameId: game.id } },
                })} style={{ marginTop: space(3) }} />
              : !canScore ? null : <Txt k="body" color={colors.muted} style={{ marginTop: space(2), fontSize: 12 }}>
                {!game.day || !game.time ? 'Awaiting a time in Connect.'
                  : !home || !away ? 'Teams will appear when this fixture is set.'
                  : 'Both teams must be linked to this mobile league before Start is available.'}
              </Txt>}
          </Card>;
        })}
      </>}
  </View>;
}
