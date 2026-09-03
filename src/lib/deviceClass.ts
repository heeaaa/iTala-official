import { useEffect, useState } from 'react';
import { Dimensions, Platform } from 'react-native';

/**
 * Is this a TABLET, as opposed to a phone in a large window?
 *
 * iTala rotates on tablets and stays portrait-locked on phones. Scorekeepers run
 * the live tracker on an iPad in landscape, but a phone must never reflow the
 * stat pad under someone's thumb mid-game - so being wrong in either direction
 * is a real bug, not a cosmetic one.
 *
 * iOS asks the platform. `Platform.isPad` is a device-class flag, so Split View
 * and Stage Manager cannot change the answer by making the window small.
 *
 * Android has no equivalent flag, so it uses the conventional smallest-width
 * >= 600dp test - but against `Dimensions.get('screen')`, NOT `'window'`.
 * `LeaguesScreen` already documents why (see the comment above its
 * `useWindowDimensions` call): `window` is the multitasking window, so an
 * Android tablet in split-screen measures narrow, would decide it was a phone,
 * and would lock itself portrait. `screen` is the display.
 *
 * Taking the SHORTEST side makes the value orientation-independent: a tablet
 * stays a tablet once it is on its side.
 */
const TABLET_MIN_DP = 600;

function measure(): boolean {
  if (Platform.OS === 'ios') return Platform.isPad === true;
  const { width, height } = Dimensions.get('screen');
  return Math.min(width, height) >= TABLET_MIN_DP;
}

/** Non-reactive answer, for module scope and non-component code. */
export const isTabletSync = measure;

/**
 * Reactive form. On iOS this never changes, but on Android a foldable crosses
 * the threshold when it opens, and a device that unfolded into a tablet and
 * stayed portrait-locked until the next cold start would be a puzzling bug to
 * report. Subscribing costs one listener for the life of the app.
 */
export function useIsTablet(): boolean {
  const [tablet, setTablet] = useState(measure);
  useEffect(() => {
    if (Platform.OS === 'ios') return;            // device class cannot change
    const sub = Dimensions.addEventListener('change', () => setTablet(measure()));
    return () => sub.remove();
  }, []);
  return tablet;
}
