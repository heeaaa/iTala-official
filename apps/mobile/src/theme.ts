/**
 * Design tokens.
 *
 * COLOUR ROLES, carried forward from v1 verbatim because the rules are the
 * design system, not the hex values:
 *
 *   teal   = identity / structure  (wordmark, primary scores, headers, focus)
 *   lime   = live / action ENERGY  (LIVE pip, armed-stat flash, primary CTA)
 *   green  = success (made shots)
 *   red    = danger  (misses, delete, foul-out warning)
 *   yellow = timeout marker in the play-by-play
 *   muted  = de-emphasised text and inactive UI
 *
 * Lime is RARE on purpose. Every place it appears should say "happening now"
 * or "do this". Putting lime on a routine button burns the eye.
 *
 * The ground is one step lighter than v1's near-black: chosen from three
 * options against the live tracker, for readability under bright gym lighting.
 * Every text colour below passes WCAG AA on the surface it sits on. `red` is
 * the brighter #FF6669 rather than v1's #FF4D4F, because on this lighter
 * surface the original fell to 4.2:1 and misses AA at 12px.
 */
export const colors = {
  bg: '#18202E',
  surface: '#242E42',
  surfaceHi: '#303C54',
  line: '#3D4A66',

  text: '#F4F8FF',
  muted: '#A2ADC8',

  brandTeal: '#12D7D0',
  brandTealDeep: '#0E9C9A',
  brandLime: '#C7F000',

  accent: '#12D7D0',
  accentDim: '#0E3F45',

  green: '#00D084',
  greenDim: '#0E3A23',
  red: '#FF6669',
  redDim: '#3A1416',
  yellow: '#FFC24B',
  live: '#C7F000',
} as const;

export const brandGradient = ['#12D7D0', '#7CE7A5', '#C7F000'] as const;
export const wordmarkGradient = ['#0E9C9A', '#12D7D0', '#C7F000'] as const;

/** Team identity. Avoids teal and lime so a team never competes with brand UI. */
export const teamColors = [
  '#3A78FF',
  '#FF6B6B',
  '#9B59FF',
  '#FFC24B',
  '#FF8A3D',
  '#22C7D6',
  '#FF4D9D',
  '#33C076',
] as const;

/** One per stat family, so the pad is readable at a glance without reading it. */
export const statColors = {
  make: '#00D084',
  miss: '#FF6669',
  reb: '#12D7D0',
  ast: '#FFC24B',
  stl: '#22C7D6',
  blk: '#9B59FF',
  tov: '#FF8A3D',
  foul: '#A2ADC8',
  onText: '#18202E',
} as const;

/** A 4px base grid. */
export const space = (n: number): number => n * 4;

export const radius = { sm: 8, md: 12, lg: 18, pill: 999 } as const;

/**
 * Depth is expressed purely through the bg -> surface -> surfaceHi value
 * ladder plus 1px lines. There are no shadows anywhere, deliberately.
 */
export const fonts = {
  display: 'Oswald_700Bold',
  displaySemi: 'Oswald_600SemiBold',
  body: 'DMSans_400Regular',
  bodyMed: 'DMSans_500Medium',
  bodyBold: 'DMSans_700Bold',
} as const;

/**
 * The complete text scale. There are exactly seven kinds; if a screen needs an
 * eighth, that is a signal to reuse one rather than to add one.
 */
export const textKinds = {
  display: { fontFamily: fonts.display, fontSize: 40, letterSpacing: 0.5, color: colors.text },
  h1: { fontFamily: fonts.display, fontSize: 28, color: colors.text },
  h2: { fontFamily: fonts.displaySemi, fontSize: 20, color: colors.text },
  body: { fontFamily: fonts.body, fontSize: 15, color: colors.text },
  label: {
    fontFamily: fonts.bodyMed,
    fontSize: 12,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  stat: { fontFamily: fonts.displaySemi, fontSize: 16, color: colors.text },
  statBig: { fontFamily: fonts.display, fontSize: 34, color: colors.text },
} as const;

export type TextKind = keyof typeof textKinds;

/**
 * Breakpoint. The scorekeepers work on an iPad in landscape, so that is a
 * first-class layout rather than a stretched phone. v1 was portrait-locked and
 * phone-shaped throughout, which is the clearest mismatch between the old app
 * and who actually uses it.
 */
export const TABLET_MIN_WIDTH = 700;
