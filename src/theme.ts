// iTala design tokens — derived from the new brand: a teal body with a lime
// accent (head-dot + speed lines) on a deep near-black ground.
//
// COLOR ROLES (strict — don't reach for the wrong one):
//   teal   = identity / structure  (wordmark, primary scores, headers, focus rings)
//   lime   = live / action ENERGY  (LIVE pip, armed-stat flash, primary CTA gradient)
//   green  = success (made shots)
//   red    = danger  (misses, delete, foul-out warning)
//   yellow = timeout marker in PBP (instantly recognizable)
//   muted  = de-emphasized text / inactive UI
//
// Lime is *rare* on purpose — every place it appears should signal "happening now"
// or "do this." Putting lime on a routine button would burn the eye.

export const colors = {
  // Deep ground — matches the black the new logo sits on
  bg: '#0A0F18',
  surface: '#172033',
  surfaceHi: '#1F2A40',
  line: '#243049',
  text: '#F4F8FF',
  muted: '#8B95B5',

  // Brand
  brandTeal: '#12D7D0',
  brandTealBright: '#0BEFF0',
  brandTealDeep: '#0E9C9A',
  brandLime: '#C7F000',
  brandLimeBright: '#E0FF3D',

  // Functional accents
  accent: '#12D7D0',       // teal — most accent UI
  accentDim: '#0E3F45',    // teal at low intensity (selected pill bg, dim borders)
  accent2: '#C7F000',      // lime — reserve for live/action signals
  accent2Dim: '#3A4400',   // lime at low intensity

  green: '#00D084',
  greenDim: '#0E3A23',
  red: '#FF4D4F',
  yellow: '#FFC24B',
  blue: '#3A78FF',

  // Live broadcast accent (used for the pulsing LIVE pip)
  live: '#C7F000',
};

// Primary action gradient: teal → lime, diagonal. Used on the most important
// CTAs (FINISH GAME, Start Game, segmented active tab, primary Button).
export const brandGradient = ['#12D7D0', '#7CE7A5', '#C7F000'] as const;

// Wordmark underline gradient (deeper, more teal-weighted — quieter than the CTA)
export const wordmarkGradient = ['#0E9C9A', '#12D7D0', '#C7F000'] as const;

// Team palette — teals and lime are reserved for brand UI, so we use a wider
// hue spread for team identity. These won't compete with the brand colors.
// 24 entries so a full 24-team league auto-assigns without repeats. The
// original 8 stay first so previously assigned team colors are unchanged.
export const teamColors = [
  '#3A78FF', // azure
  '#FF6B6B', // coral
  '#9B59FF', // purple
  '#FFC24B', // amber
  '#FF8A3D', // orange
  '#22C7D6', // cyan (teal-adjacent, distinct enough)
  '#FF4D9D', // pink
  '#33C076', // green
  '#E23E57', // crimson
  '#B23A67', // berry
  '#FF9EAF', // rose
  '#FFB4A2', // peach
  '#C0552B', // rust
  '#8B5E34', // brown
  '#F4D35E', // butter
  '#9BB537', // olive
  '#0E8A5F', // emerald
  '#6EE7B7', // mint
  '#4CC9F0', // sky
  '#5B7DB1', // steel
  '#2743A6', // navy
  '#C4B5FD', // lavender
  '#E879F9', // orchid
  '#A21CAF', // plum
];

// Spoken names for the palette above, keyed by hex so the two cannot drift out
// of order. The team-color grid is a wall of unlabelled circles: sighted users
// pick by eye, but a screen reader had nothing to announce and the only text on
// screen was the raw hex code, which means nothing to most people. Naming the
// swatch lets us show a color chip instead of "#3A78FF" without going silent.
// A color outside this list (the shade grid, or a custom hex) has no name.
export const teamColorNames: Record<string, string> = {
  '#3A78FF': 'azure',
  '#FF6B6B': 'coral',
  '#9B59FF': 'purple',
  '#FFC24B': 'amber',
  '#FF8A3D': 'orange',
  '#22C7D6': 'cyan',
  '#FF4D9D': 'pink',
  '#33C076': 'green',
  '#E23E57': 'crimson',
  '#B23A67': 'berry',
  '#FF9EAF': 'rose',
  '#FFB4A2': 'peach',
  '#C0552B': 'rust',
  '#8B5E34': 'brown',
  '#F4D35E': 'butter',
  '#9BB537': 'olive',
  '#0E8A5F': 'emerald',
  '#6EE7B7': 'mint',
  '#4CC9F0': 'sky',
  '#5B7DB1': 'steel',
  '#2743A6': 'navy',
  '#C4B5FD': 'lavender',
  '#E879F9': 'orchid',
  '#A21CAF': 'plum',
};

// Everything outside the curated palette still needs a name — the shade grid in
// EditTeam generates 36 colors from HSL and the custom-hex field allows any
// color at all, so a lookup table alone would leave 36+ swatches sharing one
// meaningless label. Derive a name from the color itself instead.
//
// Twelve hues at the 30° spacing the shade grid is generated on, plus a
// lightness band, so "#6EE7B7" reads as "light teal" rather than "#6EE7B7".
const HUE_NAMES = [
  'red', 'orange', 'yellow', 'lime', 'green', 'teal',
  'cyan', 'blue', 'indigo', 'violet', 'magenta', 'pink',
];

function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = h * 60;
  if (h < 0) h += 360;
  return { h, s: s * 100, l: l * 100 };
}

// A plain-English name for any color. Used for the visible label and the
// accessibility label in EditTeam, so a color is never communicated by hue
// alone (and never by a hex code, which is not something users read).
export function describeColor(hex: string): string {
  const exact = teamColorNames[hex.trim().toUpperCase()];
  if (exact) return exact;
  const hsl = hexToHsl(hex);
  if (!hsl) return 'custom color';
  const { h, s, l } = hsl;
  if (l >= 96) return 'white';
  if (l <= 6) return 'black';
  if (s < 10) return l >= 60 ? 'light grey' : l <= 35 ? 'dark grey' : 'grey';
  // +15 so each name is centred on its hue rather than starting at it.
  const hue = HUE_NAMES[Math.floor(((h + 15) % 360) / 30)];
  // Every derived name carries its lightness band, INCLUDING the middle one.
  // Bare `hue` would collide with the curated table - '#33C076' is named
  // "green" there, and the shade grid's mid green derives "green" too - so a
  // screen reader announced two different swatches identically. No curated
  // name starts with light/mid/deep, so banding them all keeps the two name
  // spaces disjoint.
  return l >= 62 ? `light ${hue}` : l <= 38 ? `deep ${hue}` : `mid ${hue}`;
}

// Stat pad buttons — semantic, tuned for dark UI
export const statColors = {
  make: '#00D084',     // green for made shots
  makeHi: '#1DDE96',
  miss: '#FF4D4F',     // red for misses
  missHi: '#FF6669',
  reb: '#12D7D0',      // brand teal
  ast: '#FFC24B',      // amber
  stl: '#22C7D6',      // cyan
  blk: '#9B59FF',      // purple
  foul: '#8B95B5',     // muted
  tov: '#FF8A3D',      // orange — a lost possession
  onText: '#0A0F18',   // deep ground for text on a filled colored button
};

// Game rules / limits
export const MAX_PERIOD = 9;
export const LINEUP_SIZE = 5;
export const DEFAULT_FOUL_OUT = 5; // FIBA: foul out on the 5th personal foul

export const font = {
  display: 'Oswald_700Bold',
  displaySemi: 'Oswald_600SemiBold',
  body: 'DMSans_400Regular',
  bodyMed: 'DMSans_500Medium',
  bodyBold: 'DMSans_700Bold',
};

export const radius = { sm: 8, md: 12, lg: 18, pill: 999 };
export const space = (n: number) => n * 4;
