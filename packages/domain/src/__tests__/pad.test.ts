import { describe, expect, it } from 'vitest';
import { showsAttempts, showsTurnovers, statPad } from '../pad';

describe('statPad (spec F-18, F-19 and v1 hole H-6)', () => {
  it('always offers the makes and the non-shooting stats', () => {
    const pad = statPad({ trackMisses: false, trackTurnovers: false });
    expect(pad).toEqual(['fg2_make', 'fg3_make', 'ft_make', 'reb', 'ast', 'stl', 'blk', 'pf']);
  });

  it('adds the three miss buttons only when the league tracks misses', () => {
    const pad = statPad({ trackMisses: true, trackTurnovers: false });
    expect(pad).toContain('fg2_miss');
    expect(pad).toContain('fg3_miss');
    expect(pad).toContain('ft_miss');
  });

  it('adds a turnover button only when the league tracks turnovers', () => {
    expect(statPad({ trackMisses: true, trackTurnovers: false })).not.toContain('tov');
    expect(statPad({ trackMisses: true, trackTurnovers: true })).toContain('tov');
  });

  it('never offers a legacy rebound split', () => {
    const everything = statPad({ trackMisses: true, trackTurnovers: true });
    expect(everything).not.toContain('oreb');
    expect(everything).not.toContain('dreb');
  });

  it('keeps the box score columns in step with what can be logged', () => {
    // v1 showed a TO column that could only ever be zero, because the button
    // to produce the data had been removed and the column had not.
    expect(showsTurnovers({ trackMisses: true, trackTurnovers: false })).toBe(false);
    expect(showsTurnovers({ trackMisses: true, trackTurnovers: true })).toBe(true);
    expect(showsAttempts({ trackMisses: false, trackTurnovers: false })).toBe(false);
  });
});
