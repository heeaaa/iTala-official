import { NO_VALUE } from './constants';

/**
 * Percentage as a display string. Zero attempts render as an em dash, NOT 0%,
 * because "never shot" and "shot and missed everything" are different facts.
 * Rounding is half-up, so 45.5% becomes 46%.
 */
export const pct = (made: number, att: number): string =>
  att === 0 ? NO_VALUE : `${Math.round((made / att) * 100)}%`;

/** Average to `dp` decimal places. Zero games renders as '0.0'. */
export const avg = (total: number, games: number, dp = 1): string =>
  games === 0 ? (0).toFixed(dp) : (total / games).toFixed(dp);

/**
 * The day-grouping key, in the LOCAL calendar date of whichever clock is asked.
 *
 * v1 read the device's own timezone with no override, so the same game grouped
 * under different days on devices in different timezones, and the resulting key
 * was used as a route parameter. `timeZone` is now an explicit argument so the
 * caller decides, and the spectator web view can agree with the app.
 */
export const dayKey = (ts: number, timeZone?: string): string => {
  const d = new Date(ts);
  if (!timeZone) {
    const y = d.getFullYear();
    const m = `${d.getMonth() + 1}`.padStart(2, '0');
    const day = `${d.getDate()}`.padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  // en-CA gives YYYY-MM-DD, which is exactly the key format we want.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
};

/**
 * Timeout clock input, reproduced from v1 (LiveGameScreen.tsx:323-329) because
 * the exact behaviour is load-bearing for how scorekeepers type.
 *
 *   '428'  -> '4:28'
 *   '1045' -> '10:45'
 *   anything already containing a colon passes through untouched
 *   any other length is stored verbatim
 */
export const prettyClock = (s: string): string => {
  const digits = s.replace(/[^0-9]/g, '');
  if (s.includes(':')) return s;
  if (digits.length === 3) return `${digits[0]}:${digits.slice(1)}`;
  if (digits.length === 4) return `${digits.slice(0, 2)}:${digits.slice(2)}`;
  return s;
};

/** '22/9/5' */
export const triple = (pts: number, reb: number, ast: number): string => `${pts}/${reb}/${ast}`;
