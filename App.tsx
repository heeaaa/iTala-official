import React from 'react';
import { View, ActivityIndicator, Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { MiniWordmark } from './src/components/ui';
import {
  useFonts,
  Oswald_600SemiBold, Oswald_700Bold,
} from '@expo-google-fonts/oswald';
import { DMSans_400Regular, DMSans_500Medium, DMSans_700Bold } from '@expo-google-fonts/dm-sans';

import { StoreProvider } from './src/store/StoreProvider';
import { AdminProvider } from './src/store/AdminProvider';
import { colors, font } from './src/theme';
import { useIsTablet } from './src/lib/deviceClass';
import { RootStackParams } from './src/navigation';

import LeaguesScreen from './src/screens/LeaguesScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import CreateLeagueScreen from './src/screens/CreateLeagueScreen';
import RecGameScreen from './src/screens/RecGameScreen';
import LeagueDetailScreen from './src/screens/LeagueDetailScreen';
import GamesOnDateScreen from './src/screens/GamesOnDateScreen';
import ManageRosterScreen from './src/screens/ManageRosterScreen';
import EditTeamScreen from './src/screens/EditTeamScreen';
import TeamProfileScreen from './src/screens/TeamProfileScreen';
import NewGameScreen from './src/screens/NewGameScreen';
import SelectLineupScreen from './src/screens/SelectLineupScreen';
import LiveGameScreen from './src/screens/LiveGameScreen';
import BoxScoreScreen from './src/screens/BoxScoreScreen';
import FinalScoreScreen from './src/screens/FinalScoreScreen';
import SeasonRecapScreen from './src/screens/SeasonRecapScreen';
import ShareCardScreen from './src/screens/ShareCardScreen';
import ManagePromosScreen from './src/screens/ManagePromosScreen';
import BulkImportScreen from './src/screens/BulkImportScreen';
import PlayerProfileScreen from './src/screens/PlayerProfileScreen';
import ReportContentScreen from './src/screens/ReportContentScreen';

const Stack = createNativeStackNavigator<RootStackParams>();

// Screens with no natural title show the brand mark instead of dead space.
//
// `title` is still set on every screen below, including these. On iOS the
// native stack labels the back button with the PREVIOUS screen's `title`, and
// falls back to the ROUTE NAME when there isn't one - which is how "LeagueDetail"
// came to be shown to users, unspaced, in the top left. `headerTitle` overrides
// what the header renders but is not a label, so it never filled that gap.
//
// So: `headerTitle` decides what this screen's header shows; `title` is the
// human name other screens refer to it by. Route names stay PascalCase because
// they are code identifiers keyed to RootStackParams - they are not, and should
// never be, user-visible strings. tests/static.test.js CHECK 21 fails the build
// if a screen is registered without a title.
const brandHeader = { headerTitle: () => <MiniWordmark size={20} /> };

const navTheme = {
  ...DefaultTheme,
  dark: true,
  colors: {
    ...DefaultTheme.colors,
    background: colors.bg,
    card: colors.bg,
    text: colors.text,
    border: colors.line,
    primary: colors.accent,
    notification: colors.accent,
  },
};

export default function App() {
  const [loaded, error] = useFonts({
    Oswald_600SemiBold, Oswald_700Bold,
    DMSans_400Regular, DMSans_500Medium, DMSans_700Bold,
  });

  // Don't block the app forever on font loading. If fonts are slow or fail
  // (e.g. first Expo Go launch on a flaky network), proceed after a short
  // timeout using system fonts so the app always opens.
  const [timedOut, setTimedOut] = React.useState(false);
  React.useEffect(() => {
    const t = setTimeout(() => setTimedOut(true), 3000);
    return () => clearTimeout(t);
  }, []);

  // Tablets rotate; phones do not. Called before the early return below, because
  // a hook cannot be conditional.
  const isTablet = useIsTablet();

  const ready = loaded || !!error || timedOut;

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StoreProvider>
          <AdminProvider>
            <StatusBar style="light" />
            <NavigationContainer theme={navTheme}>
              <Stack.Navigator
                screenOptions={{
                  headerStyle: { backgroundColor: colors.bg },
                  headerTintColor: colors.text,
                  headerTitleStyle: { fontFamily: font.displaySemi },
                  headerShadowVisible: false,
                  contentStyle: { backgroundColor: colors.bg },
                  // Tablets rotate so a scorekeeper can run the live tracker in
                  // landscape; phones stay exactly as they are.
                  //
                  // The OS-level ceilings are set elsewhere and this only picks
                  // within them: app.json's ios.infoPlist pins iPhone to
                  // portrait and lets iPad rotate (setting
                  // UISupportedInterfaceOrientations explicitly makes Expo skip
                  // its own iOS orientation plugin, which logs a warning about
                  // ignoring `orientation` - that warning is expected), while
                  // app.json's global `orientation: "portrait"` still writes the
                  // Android manifest lock. iOS intersects the plist with the
                  // value below, so JS can never widen past it. Android's
                  // setRequestedOrientation overrides the manifest, so on that
                  // platform the value below is the whole story.
                  //
                  // This MUST live in screenOptions and never on an individual
                  // Stack.Screen. react-native-screens resolves a screen with no
                  // orientation to SCREEN_ORIENTATION_UNSPECIFIED on Android,
                  // which OVERRIDES the manifest's portrait lock - so setting it
                  // on some screens silently frees rotation on every other one.
                  //
                  // Every arm of this is platform-specific, because the same
                  // word means different things on each side and an approximate
                  // match here is a real bug, not an untidy one.
                  //
                  // PHONES. iOS 'portrait' is Portrait+UpsideDown, exactly what
                  // the plist already says. Android 'portrait' would map to
                  // SENSOR_PORTRAIT and newly ALLOW upside-down, so it takes
                  // 'portrait_up' (= SCREEN_ORIENTATION_PORTRAIT) to match the
                  // manifest. Opposite words, identical no-op.
                  //
                  // TABLETS. iOS 'all' is UIInterfaceOrientationMaskAll, which
                  // UIKit still intersects with the Control Centre rotation
                  // lock - so a locked iPad stays put. Android 'all' maps to
                  // SCREEN_ORIENTATION_FULL_SENSOR, which is the constant that
                  // deliberately IGNORES the user's auto-rotate setting. On a
                  // tablet lying flat on a scorer's table that is precisely the
                  // mid-game reflow the phone lock exists to prevent, inflicted
                  // on someone who explicitly asked for it not to happen.
                  // 'default' maps to SCREEN_ORIENTATION_UNSPECIFIED instead:
                  // still a runtime value, so it still overrides the manifest's
                  // portrait lock and the tablet rotates - but the system, and
                  // therefore the user's lock, decides.
                  orientation: isTablet
                    ? (Platform.OS === 'ios' ? 'all' : 'default')
                    : (Platform.OS === 'ios' ? 'portrait' : 'portrait_up'),
                }}>
                <Stack.Screen name="Leagues" component={LeaguesScreen} options={{ headerShown: false, title: 'Home' }} />
                <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
                <Stack.Screen name="CreateLeague" component={CreateLeagueScreen} options={{ ...brandHeader, title: 'New League' }} />
                <Stack.Screen name="RecGame" component={RecGameScreen} options={{ ...brandHeader, title: 'Drop-In Game' }} />
                <Stack.Screen name="LeagueDetail" component={LeagueDetailScreen} options={{ ...brandHeader, title: 'League' }} />
                <Stack.Screen name="GamesOnDate" component={GamesOnDateScreen} options={{ ...brandHeader, title: 'Games' }} />
                <Stack.Screen name="ManageRoster" component={ManageRosterScreen} options={{ title: 'Roster' }} />
                <Stack.Screen name="TeamProfile" component={TeamProfileScreen} options={{ ...brandHeader, title: 'Team' }} />
                <Stack.Screen name="EditTeam" component={EditTeamScreen} options={{ title: 'Edit Team' }} />
                <Stack.Screen name="NewGame" component={NewGameScreen} options={{ ...brandHeader, title: 'New Game' }} />
                <Stack.Screen name="SelectLineup" component={SelectLineupScreen} options={{ ...brandHeader, title: 'Starting Five' }} />
                <Stack.Screen name="LiveGame" component={LiveGameScreen} options={{ ...brandHeader, title: 'Live Game', headerBackVisible: false, gestureEnabled: false }} />
                <Stack.Screen name="BoxScore" component={BoxScoreScreen} options={{ title: 'Box Score' }} />
                <Stack.Screen name="FinalScore" component={FinalScoreScreen} options={{ ...brandHeader, title: 'Final Score', headerBackVisible: false, gestureEnabled: false }} />
                <Stack.Screen name="SeasonRecap" component={SeasonRecapScreen} options={{ ...brandHeader, title: 'Season Recap' }} />
                <Stack.Screen name="ShareCard" component={ShareCardScreen} options={{ ...brandHeader, title: 'Share Card' }} />
                <Stack.Screen name="ManagePromos" component={ManagePromosScreen} options={{ ...brandHeader, title: 'Sponsor Promos' }} />
                <Stack.Screen name="BulkImport" component={BulkImportScreen} options={{ ...brandHeader, title: 'Bulk Import' }} />
                <Stack.Screen name="PlayerProfile" component={PlayerProfileScreen} options={{ ...brandHeader, title: 'Player' }} />
                <Stack.Screen name="ReportContent" component={ReportContentScreen} options={{ title: 'Report Information' }} />
              </Stack.Navigator>
            </NavigationContainer>
          </AdminProvider>
        </StoreProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
