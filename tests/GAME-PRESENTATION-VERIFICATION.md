# Game award and team-name regression evidence

Base: `96390fe` (latest `origin/main` pulled before work).
Branch: `fix/game-awards-team-name-layout`.

## Before the fix

Executed `node tests/gamePresentation.test.js` against the original production
screen code before changing it. All 15 initial checks failed:

- For league, public recreational (`isShared: true`), and private recreational
  (`isShared: false`) fixtures, the share card chose the losing team's 20-point
  scorer instead of the winning team's 10-point / 10-assist player in a 22–20
  game. Both home and away wins reproduced this mismatch.
- The live scoreboard's real `SideScore` component allowed only one line and
  did not constrain the name's width inside its badge row.
- Box-score header names had no line limit and lived in a different column
  from scores, allowing wrapped names to move independently of their scores.
- Team tabs lacked centered, bounded labels and equal-height inner backgrounds.

The layout reproduction checks component output and native layout constraints;
it is not a before/after screenshot or a native pixel measurement.

## After the fix

`node tests/gamePresentation.test.js`: all 21 checks pass. Tests execute real
screen functions with the repository's lightweight React harness and real stats
calculations. They compare the share card with Finish Game and verify exactly
one Player of the Game achievement card for all six mode/winner combinations.
They also cover level games, empty stats, and a team-only winner: a losing
player is never substituted when the winner has no eligible individual stats.

The existing level-game behavior is preserved: the best performance across both
teams is eligible when there is no winning team.

The shared live scoreboard supports two lines, bounded font reduction, and
ellipsis fallback inside its own column. Box-score headers place each name and
score in the same row. Team tabs center up to two lines and stretch both fills.
The live component is shared by league and both recreational modes.

Validation completed:

- `npm test`: all available suites passed; database tests skipped because
  `psql`/a Postgres test server are unavailable.
- `tsc --noEmit`: passed.
- ESLint on all six changed production files: passed.

## Native visual checks still required

Native iOS/Android rendering and OS image sharing were not exercised here.
On a narrow phone, for each of the three modes:

1. Spectate with `BAMBHORATS KNIGHTS` on either side. Verify the name stays
   outside LIVE/Period and scores remain aligned, including larger system text.
2. Finish a game with `TIGS HANDYMAN AND DOC FRANK`. Verify both score rows and
   selected/unselected team tabs align; swap the selected tab.
3. Share the box-score image and compare its award name with Finish Game.
   Check both home and away wins and a winner with no individual stats.
