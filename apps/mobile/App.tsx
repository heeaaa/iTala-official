import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, type Theme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useFonts } from 'expo-font';
// Imported per weight, deliberately. The package barrels bundle every weight
// AND every italic: five needed faces became roughly 1.4MB of TTF we never
// render. Subpath imports pull only the five.
import { Oswald_600SemiBold } from '@expo-google-fonts/oswald/600SemiBold';
import { Oswald_700Bold } from '@expo-google-fonts/oswald/700Bold';
import { DMSans_400Regular } from '@expo-google-fonts/dm-sans/400Regular';
import { DMSans_500Medium } from '@expo-google-fonts/dm-sans/500Medium';
import { DMSans_700Bold } from '@expo-google-fonts/dm-sans/700Bold';
import { colors, fonts } from './src/theme';
import { Spinner } from './src/ui/index';
import { StoreProvider } from './src/store/StoreProvider';
import { AdminProvider } from './src/store/AdminProvider';
import type { RootStackParams } from './src/navigation';
import { LeaguesScreen } from './src/screens/LeaguesScreen';
import { CreateLeagueScreen } from './src/screens/CreateLeagueScreen';
import { ManageRosterScreen } from './src/screens/ManageRosterScreen';
import { LeagueDetailScreen } from './src/screens/LeagueDetailScreen';
import { LeagueSettingsScreen } from './src/screens/LeagueSettingsScreen';
import { NewGameScreen } from './src/screens/NewGameScreen';
import { SelectLineupScreen } from './src/screens/SelectLineupScreen';
import { LiveGameScreen } from './src/screens/LiveGameScreen';
import { BoxScoreScreen } from './src/screens/BoxScoreScreen';

const Stack = createNativeStackNavigator<RootStackParams>();

const navTheme: Theme = {
  dark: true,
  colors: {
    primary: colors.accent,
    background: colors.bg,
    card: colors.bg,
    text: colors.text,
    border: colors.line,
    notification: colors.accent,
  },
  fonts: {
    regular: { fontFamily: fonts.body, fontWeight: '400' },
    medium: { fontFamily: fonts.bodyMed, fontWeight: '500' },
    bold: { fontFamily: fonts.bodyBold, fontWeight: '700' },
    heavy: { fontFamily: fonts.display, fontWeight: '700' },
  },
};

/** Fonts must never keep the app from opening. See AGENTS.md R-7. */
const FONT_TIMEOUT_MS = 3000;

export default function App(): React.JSX.Element {
  const [loaded, error] = useFonts({
    Oswald_600SemiBold,
    Oswald_700Bold,
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_700Bold,
  });
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    // Unconditional: it starts on mount regardless of load progress. An app
    // that opens looking slightly wrong beats an app that does not open.
    const t = setTimeout(() => setTimedOut(true), FONT_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, []);

  const ready = loaded || Boolean(error) || timedOut;

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <Spinner />
      </View>
    );
  }

  // Provider order matters: the store is the outer one, as it was in v1.
  return (
    <SafeAreaProvider>
      <StoreProvider>
        <AdminProvider>
          <StatusBar style="light" />
          <NavigationContainer theme={navTheme}>
            <Stack.Navigator
              screenOptions={{
                headerStyle: { backgroundColor: colors.bg },
                headerTintColor: colors.text,
                headerTitleStyle: { fontFamily: fonts.displaySemi },
                headerShadowVisible: false,
                contentStyle: { backgroundColor: colors.bg },
              }}
            >
              <Stack.Screen
                name="Leagues"
                component={LeaguesScreen}
                options={{ headerShown: false }}
              />
              <Stack.Screen
                name="CreateLeague"
                component={CreateLeagueScreen}
                options={{ title: '' }}
              />
              <Stack.Screen
                name="ManageRoster"
                component={ManageRosterScreen}
                options={{ title: 'Roster' }}
              />
              <Stack.Screen
                name="LeagueDetail"
                component={LeagueDetailScreen}
                options={{ title: '' }}
              />
              <Stack.Screen
                name="LeagueSettings"
                component={LeagueSettingsScreen}
                options={{ title: 'Settings' }}
              />
              <Stack.Screen name="NewGame" component={NewGameScreen} options={{ title: '' }} />
              <Stack.Screen
                name="SelectLineup"
                component={SelectLineupScreen}
                options={{ title: '' }}
              />
              <Stack.Screen
                name="LiveGame"
                component={LiveGameScreen}
                // The back chevron is deliberately removed so a scorekeeper
                // cannot accidentally leave mid-game.
                options={{ title: '', headerBackVisible: false }}
              />
              <Stack.Screen
                name="BoxScore"
                component={BoxScoreScreen}
                options={{ title: 'Box Score' }}
              />
            </Stack.Navigator>
          </NavigationContainer>
        </AdminProvider>
      </StoreProvider>
    </SafeAreaProvider>
  );
}
