import { describe, expect, it } from 'vitest';
import { avg, dayKey, pct, prettyClock, triple } from '../format.js';
import { looksLikeId, uid } from '../ids.js';

describe('pct (spec 7.5)', () => {
  it('renders an em dash for zero attempts, never 0%', () => {
    expect(pct(0, 0)).toBe('—');
  });

  it('rounds half up', () => {
    expect(pct(45.5, 100)).toBe('46%');
    expect(pct(1, 3)).toBe('33%');
    expect(pct(2, 3)).toBe('67%');
    expect(pct(0, 5)).toBe('0%');
    expect(pct(5, 5)).toBe('100%');
  });
});

describe('avg and triple', () => {
  it('handles zero games without dividing by zero', () => {
    expect(avg(0, 0)).toBe('0.0');
    expect(avg(33, 2)).toBe('16.5');
  });

  it('formats a triple as points slash rebounds slash assists', () => {
    expect(triple(22, 9, 5)).toBe('22/9/5');
  });
});

describe('prettyClock (spec F-20, reproduced exactly)', () => {
  it('expands three digits to m:ss', () => {
    expect(prettyClock('428')).toBe('4:28');
  });

  it('expands four digits to mm:ss', () => {
    expect(prettyClock('1045')).toBe('10:45');
  });

  it('passes anything containing a colon straight through', () => {
    expect(prettyClock('4:28')).toBe('4:28');
    expect(prettyClock('what:ever')).toBe('what:ever');
  });

  it('stores any other length verbatim', () => {
    expect(prettyClock('12')).toBe('12');
    expect(prettyClock('')).toBe('');
    expect(prettyClock('12345')).toBe('12345');
  });
});

describe('dayKey (spec 7.14 and trap T-13)', () => {
  // 2026-03-08T09:30:00Z. Late evening of the 8th in Vancouver is the same
  // calendar day; in Auckland it is already the 8th at 22:30.
  const ts = Date.UTC(2026, 2, 8, 9, 30, 0);

  it('produces a sortable YYYY-MM-DD key', () => {
    expect(dayKey(ts, 'UTC')).toBe('2026-03-08');
  });

  it('is explicit about the timezone rather than silently using the device', () => {
    expect(dayKey(ts, 'America/Vancouver')).toBe('2026-03-08');
    expect(dayKey(ts, 'Pacific/Auckland')).toBe('2026-03-08');
    // 15:00 UTC on the 8th is already the 9th in Auckland.
    const evening = Date.UTC(2026, 2, 8, 15, 0, 0);
    expect(dayKey(evening, 'America/Vancouver')).toBe('2026-03-08');
    expect(dayKey(evening, 'Pacific/Auckland')).toBe('2026-03-09');
  });
});

describe('uid (spec 7.2)', () => {
  it('is lexicographically sortable by creation time', () => {
    const early = uid(1_000_000_000_000);
    const late = uid(1_900_000_000_000);
    expect(early < late).toBe(true);
  });

  it('does not collide across a large batch in the same millisecond', () => {
    const set = new Set(Array.from({ length: 20_000 }, () => uid(1_700_000_000_000)));
    expect(set.size).toBe(20_000);
  });

  it('produces ids that pass the shape check', () => {
    expect(looksLikeId(uid())).toBe(true);
    expect(looksLikeId('short')).toBe(false);
    expect(looksLikeId('HAS-UPPER-AND-DASH')).toBe(false);
  });
});
