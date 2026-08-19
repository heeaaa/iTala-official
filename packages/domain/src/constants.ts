/**
 * Game-rule constants. These live beside the domain rather than beside the
 * design tokens (where v1 kept them) because they are product decisions, not
 * visual ones.
 */

/** Maximum periods in one game: 4 quarters plus 5 overtimes, or 2 halves plus 7. */
export const MAX_PERIOD = 9;

/** On-court size. Hardcodes 5-a-side; 3x3 basketball would need this configurable. */
export const LINEUP_SIZE = 5;

/** FIBA. A league may override this to 6 for NBA rules. */
export const DEFAULT_FOUL_OUT = 5;

export const DEFAULT_REGULATION_PERIODS = 4 as const;

/**
 * Team identity palette. Deliberately avoids teal and lime, which are reserved
 * for brand UI, so a team colour never competes with an app affordance.
 */
export const TEAM_COLORS = [
  '#3A78FF', // azure
  '#FF6B6B', // coral
  '#9B59FF', // purple
  '#FFC24B', // amber
  '#FF8A3D', // orange
  '#22C7D6', // cyan
  '#FF4D9D', // pink
  '#33C076', // green
] as const;

/** Drop-in teams are hidden from roster pickers this long after their last game. */
export const DROP_IN_ARCHIVE_DAYS = 5;

/**
 * The em dash used in user-facing copy for "no value": an empty streak, a
 * percentage with zero attempts, a missing jersey number. Named so every use
 * site is greppable and the whole app can be changed in one edit.
 */
export const NO_VALUE = '—';
