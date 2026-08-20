# Verifying Phase 1 on real hardware

The automated suites prove the logic. This document proves the _system_: two
real devices, a real network you can switch off, and a real database.

Phase 1 is only done when every box below is ticked on actual hardware.

## What is automated already

Run these first. If they are not green, stop.

```bash
pnpm verify                  # format, lint, typecheck, 100 tests
bash supabase/tests/run.sh   # 5 migrations + 20 database assertions
```

| Suite            | Count | Proves                                                                                                                                                                                          |
| ---------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@itala/domain`  | 82    | Every section 7 rule: the stat switch, box scores, line scores, fouls, standings, leaderboards, careers, badges, and that rows round-trip back to identical state and identical derived numbers |
| `@itala/sync`    | 18    | The outage scenario, undo across devices, ordering, retry, rejection, and that a pull never destroys unsent work                                                                                |
| `supabase/tests` | 20    | Row-level security for all three roles, admin lockout, and that the foreign keys and check constraints actually bite                                                                            |

## Setup

1. Two devices. At least one should be an iPad, since that is what the
   scorekeepers use.
2. A development build on each (`eas build --profile development`), then
   `pnpm --filter @itala/mobile start` and connect both.
3. Both pointed at the same Supabase project, with `EXPO_PUBLIC_SUPABASE_URL`
   and `EXPO_PUBLIC_SUPABASE_ANON_KEY` set.

## The acceptance test

### A. The offline game survives

- [ ] On device A, unlock admin and tap **Create a league, two teams and a
      game**. The banner settles on "All changes synced."
- [ ] On device B, unlock admin. Within a second or two it shows the same
      league and the same score, without being told to refresh.
- [ ] **Put device B into aeroplane mode.**
- [ ] On B, log 20 stats. The score updates instantly every time. The banner
      reads "20 changes not synced - waiting for a connection."
- [ ] On A, log 20 stats. A's banner stays on "All changes synced."
- [ ] **Force-quit device B entirely and reopen it.** Every one of its 20 stats
      is still there and the banner still says 20 not synced. _Nothing is ever
      applied locally without the intent to send it being recorded in the same
      transaction._
- [ ] Turn B's network back on. Within a few seconds the banner reaches "All
      changes synced."
- [ ] In the Supabase table editor, `select count(*) from events`. **It reads
      exactly 40.** Not 39, not 41.
- [ ] Install on a third device that has never seen this data. It shows all 40.

### B. Undo stays undone (v1 hole H-1)

- [ ] On A, log a stat, wait for the banner to settle, then tap **Undo**. The
      score drops.
- [ ] The event is gone from the `events` table in Supabase.
- [ ] On B, log any stat, which triggers a change on A. The undone stat **does
      not come back**. In v1 it always did.
- [ ] Repeat with A in aeroplane mode: log, undo, then reconnect. The server
      never ends up holding the undone stat.

### C. Failure is visible (v1 gap G-2)

- [ ] On A, tap the lock so the device is no longer admin, then log a stat.
      The banner turns red: "1 change could not be saved."
- [ ] v1 showed nothing at all in this situation and dropped the write.
- [ ] Unlock admin again and confirm new stats sync normally.

### D. The password is safe

- [ ] Enter the wrong password four times. Each attempt says how many tries are
      left.
- [ ] Enter it a fifth time. The device is locked out for about 15 minutes.
- [ ] Enter the **correct** password during the lockout. It is still refused.
- [ ] Search the built bundle for the password string. It is not there.

### E. The numbers are right

- [ ] Log two twos, a three and a free throw for one player. The score reads 8.
- [ ] The box score shows `3-3 FG` for that player: the made three counts in
      both field goals and threes.
- [ ] Log five fouls on one player. They are removed from the court
      automatically and cannot be put back for that game.
- [ ] The other team's foul count is unaffected.

## What Phase 1 does NOT cover

Deliberately, so it does not get mistaken for a finished app: there is one
throwaway screen, no navigation, no real stat pad, no standings, no box-score
sharing and no spectator mode. Those are Phases 2 to 5. Phase 1's only job is
to prove that the architecture holds under a bad network, and it is done when
the boxes above are ticked.

---

# Verifying Phase 2 on real hardware

Phase 2 is the complete set-up-a-league-and-run-a-game journey. Target
hardware: **iPad (A16)** for the scorekeeper, **iPhone 17** and **Poco X5 Pro
5G** for everyone else.

## J-1: first run

- [ ] Launch with no data. The home screen shows "No leagues yet" and **no
      create button**, because you are not admin yet.
- [ ] Tap the padlock, enter the password. The ADMIN MODE pill appears along
      with the New League button.
- [ ] Create a league. You land straight on the roster screen.
- [ ] Add two teams and a few players each. Each team's colour is assigned
      automatically and differs from the other.
- [ ] Tap Done. The Start Game button is enabled.

## J-2: run a whole game

- [ ] Start Game. Tap home, then away. A team cannot be picked as both.
- [ ] Lineups are pre-filled with each roster's first five. Tip off.
- [ ] **On the iPad in landscape: both teams' fives are visible at once**, and
      tapping a stat then any player logs it to that player's team. Still two
      taps. On a phone, tap the other side of the scoreboard to switch teams
      first.
- [ ] After each log the armed stat clears. Tapping the same stat twice in a
      row requires two separate arms. This is what stops double-logging.
- [ ] The score updates on the tap, with no perceptible delay.
- [ ] Undo removes the last stat and the score drops.
- [ ] Subs: tap who comes out, then who comes in. **The incoming player takes
      the outgoing player's row rather than jumping to the bottom.**
- [ ] With a slot empty, the dashed row opens Subs and the chosen player is
      appended.
- [ ] Log a fifth foul on one player. An alert names them, they leave the
      court, and they are greyed out and unselectable in Subs.
- [ ] Advance the period. Confirm the dialog. **Team fouls reset to zero;
      personal fouls do not.**
- [ ] Go back a period. The earlier team-foul count returns, because nothing
      was ever cleared.
- [ ] Finish the game. Box score opens, with the by-period strip and the
      per-team table.

## Settings, per league

- [ ] Turn **Track missed shots** off. The three miss buttons disappear and the
      box score switches to makes-only columns.
- [ ] Turn **Track turnovers** on. A TOV button appears and the TO column
      appears with it. With it off, neither exists: v1 showed a column that
      could only ever be zero.
- [ ] Set the foul limit to 6. A player is no longer fouled out on the fifth.
- [ ] Set regulation to 2 halves. The box score strip reads H1, H2, OT1.
- [ ] **Create a second league and confirm its settings are independent.** In
      v1 this was one global switch shared by every league on every device.

## Level game

- [ ] Finish a game with the scores level. The dialog offers **Add a period**
      as the primary action rather than just finishing.
- [ ] Choose Finish anyway. It is recorded as a draw, not a home win.

## Cross-device, still

- [ ] Everything from the Phase 1 checklist still holds: the offline game, undo
      staying undone, and the red banner when a write is refused.

## Accessibility spot check

- [ ] Turn on VoiceOver (iOS) or TalkBack (Android). Every stat button
      announces what it does. Player rows announce name, points and fouls. The
      padlock announces whether it locks or unlocks.
- [ ] No control is an unlabelled emoji. v1 used fourteen.
