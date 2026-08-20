import { useWindowDimensions } from 'react-native';
import { TABLET_MIN_WIDTH } from '../theme';

export interface Layout {
  width: number;
  height: number;
  isTablet: boolean;
  isLandscape: boolean;
  /**
   * True when there is room to show both benches beside the court at once.
   * This is the layout the scorekeeper actually uses: an iPad, landscape.
   */
  wide: boolean;
}

export function useLayout(): Layout {
  const { width, height } = useWindowDimensions();
  const isTablet = Math.min(width, height) >= TABLET_MIN_WIDTH;
  const isLandscape = width > height;
  return { width, height, isTablet, isLandscape, wide: isTablet && isLandscape };
}
