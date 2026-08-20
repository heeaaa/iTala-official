import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StoreProvider } from './src/store/StoreProvider.js';
import { AdminProvider } from './src/store/AdminProvider.js';
import { SkeletonScreen } from './src/screens/SkeletonScreen.js';

// Provider order matters: the store is the outer one, exactly as in v1.
export default function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <StoreProvider>
        <AdminProvider>
          <StatusBar style="light" />
          <SkeletonScreen />
        </AdminProvider>
      </StoreProvider>
    </SafeAreaProvider>
  );
}
