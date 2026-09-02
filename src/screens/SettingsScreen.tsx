import React, { useState } from 'react';
import { View, Alert } from 'react-native';
import { Screen, Txt, Card, Pill, Toggle, GoogleButton, AppleButton, Button, syncToneColor } from '../components/ui';
import { useStore } from '../store/StoreProvider';
import { useAdmin } from '../store/AdminProvider';
import { colors, space } from '../theme';
import { ScreenProps } from '../navigation';

export default function SettingsScreen({ navigation }: ScreenProps<'Settings'>) {
  const { synced, sync, refresh, prefs, setHaptics, setNotifs } = useStore();
  const { role, isAdmin, user, userId, signInWithGoogle, appleAvailable, signInWithApple, deleteAccount, signOut, authBusy, errorFor } = useAdmin();
  const [busy, setBusy] = useState(false);
  // Manual sync retry. `refresh` drains the outbox before it reads, so this is
  // "send what is waiting, then fetch", which is what somebody pressing a
  // button called Try now means by it.
  const [retrying, setRetrying] = useState(false);
  const onRetry = async () => {
    setRetrying(true);
    try { await refresh(); } finally { setRetrying(false); }
  };

  // Guests are prompted to sign in — Settings requires an account.
  if (role === 'guest') {
    const onSignIn = async (signIn: () => Promise<unknown>) => {
      setBusy(true);
      await signIn();
      setBusy(false);
      // On success role changes and this screen re-renders into the full view.
    };
    return (
      <Screen scroll>
        <View style={{ paddingTop: space(8), alignItems: 'center' }}>
          <Txt k="h1" style={{ marginBottom: space(2) }}>Sign in required</Txt>
          <Txt k="body" color={colors.muted} style={{ textAlign: 'center', marginBottom: space(6) }}>
            Settings are tied to your account. Sign in with Google to continue.
          </Txt>
          <GoogleButton onPress={() => { void onSignIn(signInWithGoogle); }} busy={busy || authBusy} style={{ alignSelf: 'stretch' }} />
          {appleAvailable ? <AppleButton onPress={() => { void onSignIn(signInWithApple); }} busy={busy || authBusy} style={{ alignSelf: 'stretch', marginTop: 10 }} /> : null}
          {errorFor('signin') ? <Txt k="body" color={colors.red} style={{ marginTop: 10, fontSize: 13 }}>{errorFor('signin')}</Txt> : null}
          <Button title="Cancel" kind="ghost" onPress={() => navigation.goBack()} style={{ alignSelf: 'stretch', marginTop: 10 }} />
        </View>
      </Screen>
    );
  }

  // App Store 5.1.1(v) / Play policy: accounts must be deletable in-app.
  const confirmDelete = () => {
    Alert.alert(
      'Delete account?',
      'This permanently deletes your sign-in and account data. It cannot be undone.\n\nLeague records and game stats are kept — they belong to the league, not your account.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete account', style: 'destructive', onPress: () => { void doDelete(); } },
      ],
    );
  };
  const doDelete = async () => {
    setBusy(true);
    const ok = await deleteAccount();
    setBusy(false);
    if (ok) {
      Alert.alert('Account deleted', 'Your account has been removed. You can keep using iTala as a guest.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } else {
      Alert.alert('Could not delete account', errorFor('account') ?? 'Something went wrong. Please try again.');
    }
  };

  return (
    <Screen scroll>
      <Txt k="h1" style={{ marginBottom: space(2) }}>Settings</Txt>
      <Txt k="body" color={colors.muted} style={{ marginBottom: space(5) }}>
        These apply across all games and devices using this app.
      </Txt>

      {/* Account */}
      <Card style={{ marginBottom: space(4) }}>
        <Txt k="label" style={{ marginBottom: space(2) }}>Account</Txt>
        {user ? (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flex: 1, marginRight: 8 }}>
                <Txt k="body" style={{ fontSize: 15 }}>{user.name}</Txt>
                <Txt k="body" color={colors.muted} style={{ fontSize: 12, marginTop: 2 }}>Signed in with Google · {user.email}</Txt>
              </View>
              {isAdmin ? <Pill label="ADMIN" color={colors.accentDim} textColor={colors.brandTeal} /> : <Pill label="MEMBER" color={colors.surfaceHi} textColor={colors.muted} />}
            </View>
            <Button title="Sign out" kind="ghost" onPress={() => { void signOut().then(() => navigation.goBack()); }} style={{ marginTop: space(3) }} />
          </>
        ) : (
          // Local-only mode (no Google available) or password-elevated device.
          <Txt k="body" color={colors.muted}>
            {isAdmin ? 'Admin unlocked on this device (password).' : 'This device is running without an account.'}
          </Txt>
        )}
      </Card>

      {/* Live tracking */}
      <Card style={{ marginBottom: space(4) }}>
        <Txt k="label" style={{ marginBottom: space(2) }}>Live tracking</Txt>
        <Toggle
          label="Haptic feedback"
          description="A light tap you can feel each time you log a stat — handy when you're not looking at the screen. Turn off to save battery."
          value={prefs.hapticsEnabled ?? true}
          onChange={setHaptics}
        />
      </Card>

      {/* Notifications */}
      <Card style={{ marginBottom: space(4) }}>
        <Txt k="label" style={{ marginBottom: space(2) }}>Notifications</Txt>
        <Toggle
          label="Game alerts for my favorites"
          description="Get a notification with the final score when a team you've starred (★) finishes a game. You'll be asked to allow notifications."
          value={prefs.notifsEnabled ?? false}
          onChange={setNotifs}
        />
      </Card>

      {/* Sync

          This card said "● Connected — changes sync across devices in real
          time" whenever `synced` was true, and `synced` is SYNC_ENABLED: a
          build-time constant, `!!(SUPABASE_URL && ANON_KEY)`, fixed when the
          bundle was compiled. It could not tell you anything about a
          connection, so it said Connected in aeroplane mode, said Connected
          with a queue of unsent stats, and said Connected while every write was
          being refused. The one screen a person opens to check on sync was the
          one screen guaranteed to agree with them.

          `sync` answers the question that was actually being asked, from
          observed reachability and the depth of the outbox. It distinguishes
          connected-and-synced, connected-and-sending, offline-with-changes-
          waiting and connected-but-refused, because those need four different
          reactions. The wording lives in sync/syncStatus.ts, with the other two
          screens that show it. */}
      <Card style={{ marginBottom: space(4) }}>
        <Txt k="label" style={{ marginBottom: space(2) }}>Sync</Txt>
        {synced ? (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: syncToneColor[sync.tone] }} />
              <Txt k="body" style={{ flex: 1 }}>{sync.label}</Txt>
            </View>
            <Txt k="body" color={colors.muted} style={{ fontSize: 13, marginTop: 6 }}>{sync.detail}</Txt>
            {/* Only offered when it can do something. Retrying a connection
                that is already working is a button that does nothing visible,
                and this screen has had enough of those. */}
            {sync.pending > 0 || sync.phase === 'offline' ? (
              <Button
                title={retrying ? 'Trying…' : 'Try now'}
                kind="ghost"
                disabled={retrying}
                onPress={() => { void onRetry(); }}
                style={{ marginTop: space(3) }}
              />
            ) : null}
            {userId ? <Txt k="body" color={colors.muted} style={{ fontSize: 11, marginTop: 8 }}>Device: {userId.slice(0, 8)}…</Txt> : null}
          </>
        ) : (
          <>
            <Txt k="body" color={colors.muted}>○ Local-only — data stays on this device.</Txt>
            <Txt k="body" color={colors.muted} style={{ fontSize: 12, marginTop: 4 }}>
              To enable multi-device sync, set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY before building. See README.
            </Txt>
          </>
        )}
      </Card>

      {/* Danger zone — only meaningful when an actual account exists */}
      {user ? (
        <Card style={{ marginTop: space(4), borderColor: colors.red }}>
          <Txt k="label" color={colors.red} style={{ marginBottom: space(2) }}>Danger zone</Txt>
          <Txt k="body" color={colors.muted} style={{ marginBottom: space(3) }}>
            Deleting your account removes your sign-in and profile permanently. League records and game stats are not affected.
          </Txt>
          <Button title={busy ? 'Deleting…' : 'Delete account'} kind="danger" disabled={busy || authBusy} onPress={confirmDelete} />
        </Card>
      ) : null}
    </Screen>
  );
}
