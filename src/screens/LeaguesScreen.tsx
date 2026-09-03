import React, { useRef, useState } from 'react';
import { View, FlatList, Pressable, Alert, TextInput, ScrollView, useWindowDimensions, RefreshControl, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Screen, Txt, Card, Button, Pill, Empty, Wordmark, PasswordModal, LivePip,
  ProfileButton, ProfileSheet, InviteCodeModal, SyncBadge, OnboardingSheet, PromoCard, Toast,
} from '../components/ui';
import { usePromos, onPromoTap } from '../lib/usePromos';
import { useStore } from '../store/StoreProvider';
import { useAdmin } from '../store/AdminProvider';
import { colors, space, font, radius } from '../theme';
import { ScreenProps } from '../navigation';

// Tap the wordmark this many times (with <1.5s between taps) to reveal the
// hidden password lock — the emergency admin backup when Google sign-in or
// the network is unavailable.
const HIDDEN_LOCK_TAPS = 10;

export default function LeaguesScreen({ navigation }: ScreenProps<'Leagues'>) {
  const { state, ready, prefs, toggleFavLeague, dispatch, refresh, synced, sync, prefsReady, initialSyncDone, dismissOnboarding, liveElsewhere } = useStore();
  const [refreshing, setRefreshing] = useState(false);
  const [onboardingClosed, setOnboardingClosed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const { activePromos, reload: reloadPromos } = usePromos();

  // Pull-to-refresh with no connection used to do nothing at all: the spinner
  // appeared, five table reads failed into a `warn` nobody sees, and the
  // spinner went away again — the same thing that happens when a refresh finds
  // no changes. `refresh` now reports which of those it was, so the gesture
  // gets an answer. It also sends anything queued before it reads, so pulling
  // down after a reconnect pushes the offline stats up rather than only
  // fetching the server's older copy.
  const onRefresh = async () => {
    setRefreshing(true);
    try {
      const [outcome] = await Promise.all([refresh(), reloadPromos()]);
      setToast(outcome === 'offline' ? 'No internet connection. Please try again.' : null);
    } finally {
      setRefreshing(false);
    }
  };
  const { role, isAdmin, user, unlock, lock, signOut, signInWithGoogle, appleAvailable, signInWithApple, authBusy, errorFor, clearError, isOwner, redeemCode, createCreationCode, canScoreGame } = useAdmin();
  const [askPw, setAskPw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [lockRevealed, setLockRevealed] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  // Measured height of the bottom action bar, so the list can reserve exactly
  // that much room instead of a hard-coded guess. See the bar's own comment.
  const [barHeight, setBarHeight] = useState(0);

  // Live-card width from the CURRENT window, not from the width at launch.
  //
  // This was `const SCREEN_W = Dimensions.get('window').width` at module scope,
  // read once when the bundle loaded and never again. `app.json` sets
  // `supportsTablet: true`, and an iPad window is resized at runtime by Split
  // View, Slide Over and Stage Manager - so the cards kept the width the app
  // launched at and stopped matching the container they sit in. `orientation:
  // "portrait"` does not save it either: that constrains rotation, not the
  // multitasking window. useWindowDimensions re-renders on every resize.
  const { width: windowW } = useWindowDimensions();

  // The bar sits at the very bottom edge, so it owes the home indicator its
  // room. `Screen` takes only the TOP safe-area edge (the nav header covers the
  // notch elsewhere), which left the fixed space(6) = 24pt to stand in for a
  // 34pt indicator inset. The floor keeps the old spacing on devices that
  // report no inset at all.
  const insets = useSafeAreaInsets();
  const barBottomPad = Math.max(insets.bottom + space(3), space(6));

  // Hidden-gesture counter (10 quick taps on the iTala wordmark).
  const tapCount = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onWordmarkTap = () => {
    tapCount.current += 1;
    if (tapTimer.current) clearTimeout(tapTimer.current);
    if (tapCount.current >= HIDDEN_LOCK_TAPS) {
      tapCount.current = 0;
      setLockRevealed(v => !v); // 10 more taps hides it again
    } else {
      tapTimer.current = setTimeout(() => { tapCount.current = 0; }, 1500);
    }
  };

  // Leagues visible on this device: all real leagues, plus recreational spaces
  // that are either the shared community one or ones this user owns. Other
  // people's personal drop-in spaces stay out of sight.
  const recLabel = (l: { isShared?: boolean }) =>
    l.isShared ? 'Community Drop-in Games (Papawis)' : 'Private Drop-In Games';

  const visibleLeagues = state.leagues.filter(
    l => !l.isArchived && (l.kind !== 'recreational' || l.isShared || isOwner(l))
  );

  // Live banner: EVERY live game across all visible leagues (a Saturday can
  // have several leagues playing at once).
  // Favourite leagues' live games come first, then the rest — a fan's own
  // league surfaces at the front of the carousel.
  const favSet = new Set(prefs.favLeagueIds);
  const loadedRefs = [...visibleLeagues]
    .sort((a, b) => (favSet.has(b.id) ? 1 : 0) - (favSet.has(a.id) ? 1 : 0))
    .flatMap(l =>
      l.games.filter(g => g.status === 'live')
        .map(g => {
          const home = l.teams.find(t => t.id === g.homeTeamId);
          const away = l.teams.find(t => t.id === g.awayTeamId);
          return {
            leagueId: l.id, gameId: g.id, leagueName: l.name,
            matchup: home && away ? `${home.name} vs ${away.name}` : null,
            location: g.location ?? null,
            // Known here, because this league's rows are on the device.
            spectator: !canScoreGame(l, g) as boolean | undefined,
          };
        })
    );

  // Live games in leagues this device has NOT loaded. The pull is scoped to the
  // leagues in use, so without this the banner would quietly narrow to those -
  // and a fan browsing for something to watch is the whole point of it. Comes
  // from one narrow live-games-only read (see fetchLiveGames).
  const visibleIds = new Set(visibleLeagues.map(l => l.id));
  // What THIS device knows about each game it holds. The server read is a
  // snapshot of `status = 'live'` rows and can be behind us: finish a game while
  // offline, or have the finish refused, and the server still says live. Keyed
  // off `liveGameIds` (live rows only) that stale row fell straight through into
  // the banner, so a game the device considered FINAL came back as a tappable
  // Live card. Local status wins for any game we actually hold; a game we have
  // never loaded is still unknown here and rightly comes from the server.
  //
  // 'scheduled' is deliberately NOT excluded: someone else starting a game we
  // hold as scheduled is exactly the case this server read exists to catch.
  const localStatus = new Map<string, string>();
  for (const l of visibleLeagues) for (const g of l.games) localStatus.set(g.id, g.status);
  const elsewhereRefs = liveElsewhere
    // Same visibility rules as everything else on this screen: archived
    // leagues and other people's private drop-in spaces stay out of sight.
    .filter(x => {
      if (!visibleIds.has(x.leagueId)) return false;
      const known = localStatus.get(x.gameId);
      // 'live' is already in loadedRefs (this would duplicate the card);
      // 'final' is the stale-server case above.
      return known !== 'live' && known !== 'final';
    })
    .map(x => ({
      leagueId: x.leagueId,
      gameId: x.gameId,
      leagueName: state.leagues.find(l => l.id === x.leagueId)?.name ?? '',
      matchup: x.homeName && x.awayName ? `${x.homeName} vs ${x.awayName}` : null,
      location: x.location,
      // NOT known here, and deliberately left undefined rather than guessed.
      // `true` would lock a scorekeeper out of their own game whenever their
      // memberships had not been read yet; LiveGameScreen recomputes the answer
      // from the league once its detail arrives, and treats "cannot tell yet"
      // as read-only in the meantime.
      spectator: undefined as boolean | undefined,
    }));

  const liveRefs = [...loadedRefs, ...elsewhereRefs]
    .sort((a, b) => (favSet.has(b.leagueId) ? 1 : 0) - (favSet.has(a.leagueId) ? 1 : 0));

  // Search + favorites. Favorites float to the top (stable within groups so
  // the newest-first creation order is otherwise preserved).
  const favLeagues = new Set(prefs.favLeagueIds);
  const q = query.trim().toLowerCase();
  const leagueList = state.leagues
    .filter(l => l.kind !== 'recreational' && !l.isArchived)
    .filter(l => !q || l.name.toLowerCase().includes(q) || l.season.toLowerCase().includes(q))
    .sort((a, b) => Number(favLeagues.has(b.id)) - Number(favLeagues.has(a.id)));
  const showSearch = visibleLeagues.filter(l => !l.isArchived).length >= 3 || q.length > 0;
  const archivedLeagues = state.leagues.filter(l => l.isArchived && l.kind !== 'recreational');

  // Both sheets clear their OWN flow's error on the way in. Scoping already
  // stops one flow's failure appearing inside another's sheet; this also stops
  // a stale failure from the previous attempt greeting the next one.
  const openProfileSheet = () => { clearError('signin'); setSheetOpen(true); };

  const onLockPress = () => {
    if (isAdmin) { void lock(); return; } // tapping the unlocked icon re-locks
    clearError('admin');
    setAskPw(true);
  };

  const submitPw = async (pw: string) => {
    setSubmitting(true);
    const ok = await unlock(pw);
    setSubmitting(false);
    if (ok) setAskPw(false);
    // on failure, lastError from context is shown in the modal automatically
  };

  const onGoogle = async () => {
    const resultRole = await signInWithGoogle();
    if (resultRole) setSheetOpen(false);
    // on failure/cancel, lastError (if any) shows inside the sheet
  };

  const onApple = async () => {
    const resultRole = await signInWithApple();
    if (resultRole) setSheetOpen(false);
  };

  const onSignOut = async () => {
    await signOut();
    setSheetOpen(false);
  };

  const submitCode = async (code: string) => {
    setCodeBusy(true); setCodeError(null);
    const res = await redeemCode(code);
    setCodeBusy(false);
    if (res.type === 'error') { setCodeError(res.message); return; }
    setCodeOpen(false);
    if (res.type === 'create') {
      navigation.navigate('CreateLeague', { code: code.trim().toUpperCase() });
    } else {
      Alert.alert(
        res.role === 'owner' ? "You're now a co-owner" : "You're now a scorekeeper",
        `You joined ${res.leagueName} as ${res.role === 'owner' ? 'a co-owner' : 'a scorekeeper'}.`,
      );
    }
  };

  // New League: Super Admins go straight in; everyone else needs a single-use
  // creation code from a Super Admin (the same code field handles it).
  const onNewLeague = () => {
    if (isAdmin) { navigation.navigate('CreateLeague', {}); return; }
    setCodeError(null);
    setCodeOpen(true);
  };

  // Super Admin: mint a creation code to hand to a new league organizer.
  const onMintCode = async () => {
    const code = await createCreationCode();
    if (code) {
      Alert.alert('League-creation code', `${code}

Share this with the organizer. It can create exactly one league, then expires.`);
    } else {
      Alert.alert('Could not create code', errorFor('admin') ?? 'Try again.');
    }
  };

  const onAbout = () => {
    setSheetOpen(false);
    Alert.alert(
      'iTala',
      'Record. Track. Elevate.\n\nLive basketball stat tracking, league standings, and shareable stat cards for the people you play with.\n\nVersion 1.0.0',
      [{ text: 'OK' }],
    );
  };

  return (
    <Screen inset>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingHorizontal: space(4), paddingTop: space(2), paddingBottom: space(3) }}>
        {/* Wordmark doubles as the hidden-lock gesture target */}
        <Pressable onPress={onWordmarkTap}>
          <Wordmark size={40} />
          <Txt k="body" color={colors.muted} style={{ marginTop: 6 }}>Record. Track. Elevate.</Txt>
        </Pressable>
        {/* The save indicator, under the profile photo.

            It was ABSOLUTELY POSITIONED at left: space(4), top: space(2) + 58 —
            on top of the tagline, not under it. The wordmark is 40pt tall plus
            a 6pt underline gap and a 3pt rule, so "Record. Track. Elevate."
            starts at roughly 55pt from the top of the header and the badge was
            laid over it at 58. Nothing enforced the number, and the two
            overlapped whenever the badge had anything to say, which offline is
            constantly.

            Absolute positioning was the bug, not the coordinate. This sits in
            normal flow at the end of the right-hand column, under the avatar,
            so it cannot be laid over anything at any text size — and it is the
            one part of the header with room to grow, which matters now that the
            label can read "Offline · 3 changes waiting" rather than a fixed
            word. maxWidth keeps a long label off the wordmark on a narrow
            phone; SyncBadge caps it at one line. */}
        <View style={{ alignItems: 'flex-end' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            {/* Settings gear: admin shortcut (Settings is also in the profile sheet) */}
            {isAdmin && (
              <Pressable onPress={() => navigation.navigate('Settings')} hitSlop={12}
                style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }}>
                <Txt k="h2" color={colors.muted}>⚙️</Txt>
              </Pressable>
            )}
            {/* Hidden password lock — emergency backup. Revealed by the wordmark
                gesture; also shown while password-elevated so it can re-lock. */}
            {(lockRevealed || (isAdmin && !user)) && (
              <Pressable onPress={onLockPress} hitSlop={12}
                style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: isAdmin ? colors.accentDim : colors.surface, borderWidth: 1, borderColor: isAdmin ? colors.brandTeal : colors.line }}>
                <Txt k="h2" color={isAdmin ? colors.brandTeal : colors.muted}>{isAdmin ? '🔓' : '🔒'}</Txt>
              </Pressable>
            )}
            {/* Profile: guest 👤 or the Google avatar */}
            <ProfileButton avatarUrl={user?.avatarUrl} onPress={openProfileSheet} />
          </View>
          <View style={{ marginTop: 6, maxWidth: 168, alignItems: 'flex-end' }}>
            <SyncBadge sync={sync} onPress={() => Alert.alert('Sync status', sync.detail)} />
          </View>
        </View>
      </View>

      {/* Transient messages.

          Absolutely positioned and pointer-transparent, so a toast never moves
          the list underneath it or eats a tap meant for a league card - the
          whole point of answering the refresh gesture this way rather than with
          a banner in the flow, which would push every card down and then let
          them spring back.

          Anchored above the bottom action bar, using the bar's OWN measured
          height rather than a guess at it. The obvious spot is the top, and the
          top is where the header is: the sync badge two elements up is in this
          diff precisely because something was positioned over that text with a
          hard-coded offset. */}
      <View
        pointerEvents="none"
        style={{ position: 'absolute', left: space(4), right: space(4), bottom: barHeight + space(3), zIndex: 60 }}>
        <Toast message={toast} onHide={() => setToast(null)} />
      </View>

      {isAdmin && (
        <View style={{ marginHorizontal: space(4), marginBottom: space(3) }}>
          <Pill label="SUPER ADMIN — full access to every league" color={colors.accentDim} textColor={colors.brandTeal} />
        </View>
      )}

      {liveRefs.length > 0 && (
        // One live game → full-width card. Several → horizontal carousel so
        // every court gets a card; peek of the next card invites the swipe.
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          snapToAlignment="start"
          decelerationRate="fast"
          // flexShrink: 0 is the load-bearing half, and its absence was a real
          // bug: "LIVE NOW" was sliced along the card's top border and the
          // location along the bottom.
          //
          // React Native's ScrollView applies `flexGrow: 1, flexShrink: 1` of
          // its own (Libraries/Components/ScrollView/ScrollView.js,
          // `baseHorizontal`). `flexGrow: 0` overrides the GROW half only, so
          // the carousel stayed shrinkable - and this column overflows, because
          // the league FlatList below wants far more height than the screen
          // has. Yoga therefore squeezed the carousel to roughly 83pt for a card
          // whose content needs about 101, and `overflow: 'scroll'` clipped the
          // 9pt that spilled above and the 9pt below. Everything else in this
          // column is a plain View, which defaults to flexShrink: 0, which is
          // why the live card was the only thing that clipped.
          //
          // The FlatList absorbs the overflow instead, which is where it belongs:
          // it scrolls.
          style={{ flexGrow: 0, flexShrink: 0, marginBottom: space(3) }}
          contentContainerStyle={{ paddingHorizontal: space(4), gap: 10 }}>
          {liveRefs.map(ref => (
            <Pressable
              key={ref.gameId}
              onPress={() => navigation.navigate('LiveGame', { leagueId: ref.leagueId, gameId: ref.gameId, spectator: ref.spectator })}
              style={{
                // Capped, because these are proportions of the window and a
                // tablet in landscape is 1366pt wide: a single card would be
                // 1334pt, wider than most laptop screens, and the carousel
                // would show about one card per swipe on a display that could
                // hold three. The cap only ever engages on a tablet - every
                // phone width stays well under it, so the phone layout is
                // untouched.
                width: Math.min(
                  liveRefs.length === 1 ? windowW - space(4) * 2 : windowW * 0.78,
                  520,
                ),
                backgroundColor: colors.surface, borderRadius: 14, padding: 14,
                borderWidth: 1, borderColor: colors.brandTeal,
                flexDirection: 'row', alignItems: 'center', gap: 12,
              }}>
              <View style={{ width: 4, alignSelf: 'stretch', backgroundColor: colors.brandTeal, borderRadius: 2 }} />
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <LivePip size={7} />
                  <Txt k="label" color={colors.brandLime}>Live now</Txt>
                </View>
                <Txt k="h2" color={colors.text} numberOfLines={1}>{ref.leagueName}</Txt>
                {ref.matchup ? (
                  <Txt k="body" color={colors.muted} numberOfLines={1} style={{ fontSize: 13, marginTop: 1 }}>{ref.matchup}</Txt>
                ) : null}
                {ref.location ? (
                  <Txt k="body" color={colors.muted} numberOfLines={1} style={{ fontSize: 11, marginTop: 2 }}>📍 {ref.location}</Txt>
                ) : null}
              </View>
              <Txt k="h1" color={colors.brandTeal}>▶</Txt>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {showSearch && (
        <View style={{ paddingHorizontal: space(4), marginBottom: space(3) }}>
          <TextInput
            value={query} onChangeText={setQuery}
            placeholder="Search leagues by name or season" placeholderTextColor={colors.muted}
            style={{ backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, color: colors.text, paddingHorizontal: 14, paddingVertical: 11, fontFamily: font.body, fontSize: 15 }}
          />
        </View>
      )}

      <FlatList
        data={leagueList}
        keyExtractor={l => l.id}
        // Measured, not guessed: `barHeight` comes from the action bar's own
        // onLayout, plus a gap so the last row clears it rather than touching it.
        // The space(52)/space(36) guesses this replaces were 50px short for a
        // Super Admin, which is what buried the archived-leagues footer.
        contentContainerStyle={{ flexGrow: 1, paddingHorizontal: space(4), paddingBottom: role === 'guest' ? space(10) : barHeight + space(4) }}
        refreshControl={synced ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brandTeal} colors={[colors.brandTeal]} /> : undefined}
        ListHeaderComponent={(() => {
          const recs = visibleLeagues.filter(l =>
            l.kind === 'recreational' && l.games.length > 0 && (!q || recLabel(l).toLowerCase().includes(q))
          );
          const homePromos = activePromos.filter(p => p.showOnHome);
          const showPromo = !q && homePromos.length > 0;
          if (recs.length === 0 && !showPromo) return null;
          return (
            <>
              {showPromo && (
                <View style={{ marginBottom: space(3) }}>
                  <PromoCard promos={homePromos} onPress={onPromoTap} />
                </View>
              )}
              {recs.length > 0 && (
              <View style={{ marginBottom: space(3) }}>
                <Txt k="label" color={colors.muted} style={{ marginBottom: space(2) }}>RECREATIONAL/DROP-IN GAMES</Txt>
                {recs.map((rec, i) => {
                  const finals = rec.games.filter(g => g.status === 'final').length;
                  const live = rec.games.filter(g => g.status === 'live').length;
                  return (
                    <Pressable key={rec.id}
                      onPress={() => navigation.navigate('LeagueDetail', { leagueId: rec.id })}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.line }}>
                      <Txt k="h2">🏀</Txt>
                      <View style={{ flex: 1 }}>
                        <Txt k="body" style={{ fontSize: 15 }}>{recLabel(rec)}</Txt>
                        <Txt k="body" color={colors.muted} style={{ fontSize: 12 }}>
                          {rec.isShared ? 'Public games from all users' : 'Your private games'}
                        </Txt>
                      </View>
                      {live ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <LivePip size={7} />
                          <Txt k="label" color={colors.brandLime}>LIVE</Txt>
                        </View>
                      ) : (
                        <Txt k="body" color={colors.muted} style={{ fontSize: 12 }}>{finals} played ›</Txt>
                      )}
                    </Pressable>
                  );
                })}
              </View>
              )}
            </>
          );
        })()}
        ListEmptyComponent={
          !ready || (!initialSyncDone && !q)
            ? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: space(10) }}>
                <ActivityIndicator color={colors.brandTeal} size="large" />
              </View>
            : q
              ? <Empty title="No matches" subtitle={`No league matches "${query}".`} />
              : <Empty title="No leagues yet" subtitle="Create your first league to start tracking games." />
        }
        ListFooterComponent={isAdmin && archivedLeagues.length > 0 ? (
          <View style={{ marginTop: space(2) }}>
            <Pressable onPress={() => setShowArchived(v => !v)} style={{ paddingVertical: 10 }}>
              <Txt k="body" color={colors.muted}>
                {showArchived ? '▾' : '▸'} 🗄 Archived leagues ({archivedLeagues.length}) — Super Admins only
              </Txt>
            </Pressable>
            {showArchived && archivedLeagues.map(l => (
              <Card key={l.id} style={{ marginBottom: space(3), opacity: 0.75 }} onPress={() => navigation.navigate('LeagueDetail', { leagueId: l.id })}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flex: 1 }}>
                    <Txt k="h2">{l.name}</Txt>
                    <Txt k="body" color={colors.muted}>{l.season} · archived</Txt>
                  </View>
                  <Button title="Unarchive" kind="ghost" style={{ paddingVertical: 8, paddingHorizontal: 14 }}
                    onPress={() => dispatch({ t: 'SET_LEAGUE_SETTINGS', leagueId: l.id, isArchived: false })} />
                </View>
              </Card>
            ))}
          </View>
        ) : null}
        renderItem={({ item }) => {
          const finals = item.games.filter(g => g.status === 'final').length;
          const fav = favLeagues.has(item.id);
          return (
            <Card style={{ marginBottom: space(3) }} onPress={() => navigation.navigate('LeagueDetail', { leagueId: item.id })}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View style={{ flex: 1 }}>
                  <Txt k="h2">{item.name}</Txt>
                  <Txt k="body" color={colors.muted}>{item.season}</Txt>
                </View>
                {/* Favorite star: tap to pin this league to the top of the list */}
                <Pressable onPress={() => toggleFavLeague(item.id)} hitSlop={12} style={{ marginRight: 10, padding: 2 }}>
                  <Txt k="h2" color={fav ? colors.yellow : colors.muted}>{fav ? '★' : '☆'}</Txt>
                </Pressable>
                <Pill label={`${item.teams.length} teams`} />
              </View>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: space(3) }}>
                <Pill label={`${item.players.length} players`} color={colors.surfaceHi} textColor={colors.muted} />
                <Pill label={`${finals} games played`} color={colors.surfaceHi} textColor={colors.muted} />
              </View>
            </Card>
          );
        }}
      />

      {role !== 'guest' && (
        // ONE row, the same for every role.
        //
        // This used to be a stack of full-width buttons that grew with the
        // user's rights: two for a signed-in user, FOUR for a Super Admin. At
        // four it stood 258px tall while the list below it reserved only
        // space(52) = 208px, so the last 50px of the list - which is exactly
        // where the "Archived leagues" footer sits - was permanently underneath
        // the bar and could not be scrolled into view. A Super Admin could not
        // reach their own archived leagues at all.
        //
        // Two fixes, because either alone would leave the trap in place:
        //   * the two Super-Admin-only tools moved into the profile sheet,
        //     where Settings and the invite code already live, so the bar is a
        //     constant height for everyone and reads like a normal app;
        //   * the list's bottom padding is now MEASURED off this bar rather
        //     than guessed, so no future button can outgrow it again.
        <View
          onLayout={e => {
            const h = Math.round(e.nativeEvent.layout.height);
            setBarHeight(prev => (Math.abs(prev - h) > 1 ? h : prev));
          }}
          style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            paddingHorizontal: space(4), paddingTop: space(3), paddingBottom: barBottomPad,
            flexDirection: 'row', gap: 10,
            backgroundColor: colors.bg, borderTopWidth: 1, borderTopColor: colors.line,
          }}>
          {/* No decorative glyphs: the basketball emoji rendered from a
              different font with a taller line box, which made the ghost button
              taller than its neighbour on top of the box-model difference the
              Button primitive now handles. Plain labels also read better to a
              screen reader. */}
          <Button title="Drop-In" kind="ghost" style={{ flex: 1 }} onPress={() => navigation.navigate('RecGame')} />
          <Button title="New League" style={{ flex: 1 }} onPress={onNewLeague} />
        </View>
      )}

      <OnboardingSheet
        visible={prefsReady && !prefs.seenOnboarding && !onboardingClosed}
        onNeverShow={() => { setOnboardingClosed(true); dismissOnboarding(); }}
        isSignedIn={!!user}
        onClose={() => setOnboardingClosed(true)}
      />

      <ProfileSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        user={user}
        role={role}
        busy={authBusy}
        error={errorFor('signin')}
        onGoogle={() => { void onGoogle(); }}
        onApple={appleAvailable ? () => { void onApple(); } : undefined}
        onSignOut={() => { void onSignOut(); }}
        onSettings={() => { setSheetOpen(false); navigation.navigate('Settings'); }}
        onAbout={onAbout}
        onEnterCode={user ? () => { setSheetOpen(false); setCodeError(null); setCodeOpen(true); } : undefined}
        // Super-Admin-only tools. They used to be two more full-width buttons in
        // the bottom bar, which is what pushed it past the room the list
        // reserved. They belong here with Settings and the invite code: rarely
        // used, and nothing to do with starting a game.
        onMintCode={isAdmin ? () => { void onMintCode(); } : undefined}
        onPromos={isAdmin ? () => { setSheetOpen(false); navigation.navigate('ManagePromos'); } : undefined}
      />

      <InviteCodeModal
        visible={codeOpen}
        message="One code does it all — create a league, or join one as a co-owner or scorekeeper."
        error={codeError}
        busy={codeBusy}
        showRequestLink
        onSubmit={(c) => { void submitCode(c); }}
        onCancel={() => setCodeOpen(false)}
      />

      <PasswordModal
        visible={askPw}
        title="Admin access"
        message="Backup admin unlock. Enter the admin password to unlock stat tracking without a Google account."
        error={errorFor('admin') ?? undefined}
        busy={submitting}
        onSubmit={submitPw}
        onCancel={() => setAskPw(false)}
      />
    </Screen>
  );
}
