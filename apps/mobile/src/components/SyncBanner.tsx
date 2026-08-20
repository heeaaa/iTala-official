import React from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Txt } from '../ui/index';
import { colors, radius, space } from '../theme';
import { useStore } from '../store/StoreProvider';

/**
 * The single most important widget in the app.
 *
 * v1 could have every write rejected by the server and still look completely
 * normal, so a scorekeeper could lose a whole game without a hint that
 * anything was wrong. This is the fix, and it is deliberately not dismissible.
 */
export function SyncBanner(): React.JSX.Element | null {
  const { status, reconcile } = useStore();

  if (!status.enabled) return null;
  if (status.rejected === 0 && status.pending === 0) return null;

  const bad = status.rejected > 0;
  const n = bad ? status.rejected : status.pending;
  const noun = `${n} change${n === 1 ? '' : 's'}`;

  return (
    <Pressable
      onPress={() => void reconcile()}
      accessibilityRole="button"
      accessibilityLabel={
        bad ? `${noun} could not be saved. Tap to retry.` : `${noun} not yet synced. Tap to retry.`
      }
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space(2),
          backgroundColor: bad ? colors.redDim : colors.surface,
          borderColor: bad ? colors.red : colors.yellow,
          borderWidth: 1,
          borderRadius: radius.md,
          paddingVertical: space(2.5),
          paddingHorizontal: space(3),
        }}
      >
        <Icon name={bad ? 'alert' : 'undo'} size={15} color={bad ? colors.red : colors.yellow} />
        <Txt color={bad ? colors.red : colors.yellow} style={{ flex: 1, fontSize: 13 }}>
          {bad
            ? `${noun} could not be saved. Unlock admin and try again.`
            : `${noun} not synced${status.stalled ? ', waiting for a connection' : ', sending'}.`}
        </Txt>
      </View>
    </Pressable>
  );
}
