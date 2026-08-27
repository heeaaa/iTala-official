# iTala manual regression checklist

Covers what automation cannot reach: rendering, navigation, gestures, native
modules, real permissions, and multi-device sync. Run `npm test` first, since a
failure there makes most of this moot.

Report failures by id, for example "R14 failed", so the exact case is unambiguous.

---

## Before you start

- [ ] **P0.1** Re-run `supabase/schema.sql` in the Supabase SQL Editor. Several
      recent fixes depend on new database functions (`rec_setup_game`,
      `bulk_import_roster`). Without this, drop-in games will fail loudly.
- [ ] **P0.2** Confirm Anonymous sign-in is enabled (Authentication → Providers).
- [ ] **P0.3** `npm test` passes.
- [ ] **P0.4** Sign in with Google. Several flows require an account, and a
      guest session will make them look broken when they are not.
- [ ] **P0.5** Ideally have a **second device** (or a second account) available.
      Sync and spectator cases cannot be tested with one device.

### Already automated - do not spend manual time here

Stats maths, standings, box-score totals, career stats, awards, the roster
parser, reducer state transitions, route registration, and the SQL functions are
all covered by `npm test`. Test the **surfaces**, not the arithmetic.

---

## P1. Recently changed or previously broken (test these first)

Highest probability of defects. Each of these was a real bug at some point.

### Drop-in games (most fragile area historically)

- [ ] **R1** Community drop-in: create a game with location, two team names,
      players on both sides. Tap Next.
      *Expect:* a brief spinner only. No "Game not found" text flash, no crash.
- [ ] **R2** Same as R1 in the **Private** drop-in space.
- [ ] **R3** Immediately after creating, open the live card from Home.
      *Expect:* opens normally. No crash, no app exit.
- [ ] **R4** Check the game in history / Games tab.
      *Expect:* both real team names shown. **No "?" as a team name.**
- [ ] **R5** Create a drop-in game, then immediately navigate around fast (Home,
      into the league, open the live card) while it is still saving.
      *Expect:* the game and its teams persist. This is the exact race that used
      to delete them.
- [ ] **R6** Pick a starting lineup, tap Next, then check the live tracker.
      *Expect:* the lineup you chose is already applied. You should not have to
      re-select it.
- [ ] **R7** Repeat R6 three or four times. The old bug was intermittent, so a
      single pass proves little.
- [ ] **R8** Set team colours during creation (tap the colour swatch to cycle).
      *Expect:* chosen colours appear in the tracker, box score and share cards.
- [ ] **R9** Per-game stat toggles at creation (track misses / turnovers off).
      *Expect:* the tracker and box score respect the per-game choice, not the
      league default.
- [ ] **R10** Kill the app, reopen, open a drop-in game created earlier.
      *Expect:* still there with correct teams and players.

### Undo persistence (fixed this session)

- [ ] **R11** Log a stat, tap Undo, then pull to refresh (or wait for a sync
      cycle). *Expect:* the stat stays gone. It must **not** reappear.
- [ ] **R12** Log a stat, Undo, Redo, then refresh.
      *Expect:* the stat is present.
- [ ] **R13** Two devices on the same game: log a stat on device A, Undo on A.
      *Expect:* it disappears on device B too.
- [ ] **R14** Undo in game 1 while game 2 also has events.
      *Expect:* only game 1 is affected.
- [ ] **R14a** Tap a stat and tap **Undo immediately** (within a second), several
      times in a row, then pull to refresh. On a deliberately bad connection if
      you can - hotspot with one bar, or airplane mode toggled mid-tap.
      *Expect:* the score matches what you left it at. This is the race where the
      delete used to overtake the insert it was undoing, leaving the row alive on
      the server; the pull then handed it back.
- [ ] **R14b** Same as R14a on two devices, watching device B.
      *Expect:* B never shows a phantom basket, even briefly.
- [ ] **R14c** Foul a player up to their limit so they auto-bench, then Undo.
      *Expect:* they are back on the floor with one fewer foul, on **both**
      devices. Then repeat, but sub someone in for them first before undoing.
      *Expect:* the court still has five - the replacement keeps the slot.
- [ ] **R14d** Have an owner close the league (or revoke your scorekeeper access)
      while you still have the game open, then Undo a stat.
      *Expect:* the sync badge shows an **error** rather than "saved". A refused
      delete used to look identical to a successful one.

### Owner permissions (was a lockout bug)

- [ ] **R15** As Super Admin, mint a league-creation code.
- [ ] **R16** On a **second account**, redeem it and create a league.
      *Expect:* immediately after creation you can add teams, add players, start
      a game and open settings. No app restart needed.
- [ ] **R17** That owner can generate owner and scorekeeper codes for their league.
- [ ] **R18** A third account redeems the scorekeeper code.
      *Expect:* can score games, but **cannot** change league settings or delete.
- [ ] **R19** A signed-in user with no membership opens that league.
      *Expect:* read-only. No scoring or editing controls.

### Bulk roster import

- [ ] **R20** In a brand-new empty league, the "Bulk import roster" button is
      visible (owner only, non-drop-in).
- [ ] **R21** It is **hidden** once the league has at least one team.
- [ ] **R22** Paste your real six-team roster. Preview parses it.
      *Expect:* correct teams and players, jersey numbers as written including
      leading zeros.
- [ ] **R23** Amber flagged rows appear for the slash name and the stray line.
      *Expect:* two flags, each with a readable reason.
- [ ] **R24** Edit a flagged row inline, delete the stray row, rename a team,
      add a player, add a team.
- [ ] **R25** Confirm. *Expect:* **every** team and player lands. Count them
      against the preview total. This is the bug that dropped players.
- [ ] **R26** Reopen the league after a refresh and recount.
      *Expect:* nothing vanished.
- [ ] **R27** Try the same from the League detail → Roster tab entry point.

### Sponsor promos

- [ ] **R28** As Super Admin, create a promo with image, sponsor name, title,
      tagline and a link. Leave "Show on Home" **off**.
- [ ] **R29** Go to Home. *Expect:* no large promo card.
- [ ] **R30** Turn "Show on Home" on, go back to Home.
      *Expect:* the card appears **immediately**, no app restart.
- [ ] **R31** Turn it off, go back. *Expect:* gone immediately.
- [ ] **R32** Two active promos with Show on Home.
      *Expect:* Home rotates between them with position dots.
- [ ] **R33** Tap a promo **with** a link. *Expect:* opens the URL.
- [ ] **R34** A promo with **no** link. *Expect:* not tappable, no dead tap.
- [ ] **R35** Tap counts increment in the manage screen (including for the
      no-link promo).
- [ ] **R36** Every placement shows a visible "SPONSORED" label.
- [ ] **R37** Finish a game. *Expect:* compact promo strip on the final screen.
- [ ] **R38** Spectator view of a live game. *Expect:* promo banner present.
- [ ] **R39** Share an achievement card. *Expect:* **no** promo on the card
      (deliberate).
- [ ] **R40** Non-admin account. *Expect:* no "Sponsor promos" button on Home.

### Share cards (layout was clipping and duplicating)

- [ ] **R41** Finish a game, open "Player achievement cards", pick a player.
- [ ] **R42** Check each offered card type.
      *Expect:* points as the hero number, then REB / AST / STL / BLK chips in
      that order, **no stat repeated**, zeros skipped.
- [ ] **R43** Double-Double card specifically. This is where REB and PTS were
      duplicated.
- [ ] **R44** No text is **clipped at the top** - long player names, big point
      numbers, PPG values, the MVP pill.
- [ ] **R45** The score/date context line does **not** overlap "PRESENTED BY".
- [ ] **R46** Footer shows the gradient line plus "RECORD · TRACK · ELEVATE" and
      the BPBL sponsor mark.
- [ ] **R47** Toggle Story (portrait) and Feed (square). Check both for R44-R46.
- [ ] **R48** Try a very long player name in Feed layout (tightest case).
- [ ] **R49** Season award cards from League detail (needs 6+ finished games):
      MVP, scoring, assist, rebounding, defensive, most improved, first team.
- [ ] **R50** Season averages card from a player profile.
- [ ] **R51** The original "Share stat card" on the player profile still works
      (backward compatibility).

### Auth (session purge fixed this session)

- [ ] **R52** Cold start the app. *Expect:* no "Invalid Refresh Token" error,
      and boot is not stalled for ~10 seconds.
- [ ] **R53** Sign out, then sign back in with Google.
- [ ] **R54** Sign in with Apple (device build only).
- [ ] **R55** Browse as guest without signing in.
      *Expect:* can view public content, prompted to sign in where required.
- [ ] **R56** Guest taps Recreational / Drop-In Game.
      *Expect:* a clear "Sign in required" screen, not a failure later.

---

## P2. Core happy paths

### League lifecycle

- [ ] **R57** Super Admin creates a league directly (no code needed).
- [ ] **R58** Add several teams, each with players (numbers and names).
- [ ] **R59** Edit a team: rename, change colour, set a logo from photos, coach.
- [ ] **R60** Delete a player, then delete a team. *Expect:* no orphaned data,
      no crash on screens that referenced them.
- [ ] **R61** Team profile screen: roster, stats, game history.
- [ ] **R62** Player profile: career stats, game log, best game.
- [ ] **R63** Favourite a team (star). *Expect:* pins to the top and persists
      across restart.
- [ ] **R64** Roster search filters correctly.
- [ ] **R65** League settings: track misses, track turnovers, foul-out limit.
- [ ] **R66** Close the season, then view Season Recap.
- [ ] **R67** Archive a league. *Expect:* moves out of the main list.
- [ ] **R68** Duplicate a league. *Expect:* teams and players copied, no games.

### Full game flow

- [ ] **R69** Create a scheduled game (home vs away, date, location).
- [ ] **R70** Select starting lineups for both teams.
- [ ] **R71** Log the full stat range: 2pt make/miss, 3pt make/miss, FT
      make/miss, rebound, assist, steal, block, turnover, foul.
- [ ] **R72** Verify the live score updates correctly after each.
- [ ] **R73** Undo and Redo repeatedly.
- [ ] **R74** Substitute players. *Expect:* five on court maintained.
- [ ] **R75** Foul a player up to the limit.
      *Expect:* foul-out alert and automatic removal from court.
- [ ] **R76** Timeouts recorded per team per period.
- [ ] **R77** Advance periods 1 → 2 → 3 → 4. *Expect:* period persists if you
      leave and return.
- [ ] **R78** Play-by-play log shows events in order with correct labels.
- [ ] **R79** Milestone banners fire at 25 / 50 / 100 points and for
      double/triple-doubles, and are not excessively noisy.
- [ ] **R80** Record attendance, including benched players.
      *Expect:* counts toward Games Played.
- [ ] **R81** The Cancel and Save Attendance buttons have **centred** text.
- [ ] **R82** Finish the game. *Expect:* Final Score screen appears.
- [ ] **R83** Final screen has **only** "View box score". No "Done" button.
- [ ] **R84** From the box score, back returns to the league, **not** Home.
- [ ] **R85** Box score: both teams, per-player lines, shooting splits, totals.
- [ ] **R86** Standings update: wins, losses, points for/against, streak.
- [ ] **R87** Leaders / leaderboards populate.

### Exit guard

- [ ] **R88** During live scoring, the red "✕ Exit" button is at the top right,
      clearly separated from the stat pad.
- [ ] **R89** Tap it. *Expect:* a confirm dialog with Stay and Leave.
- [ ] **R90** Choose Stay. *Expect:* you remain in the tracker and it still works.
- [ ] **R91** Choose Leave. *Expect:* exits cleanly, game still live.
- [ ] **R92** Try the iOS back-swipe during scoring.
      *Expect:* it does not silently dump you out mid-game.
- [ ] **R93** Android hardware back during scoring. *Expect:* the same guard.
- [ ] **R94** As a spectator, back-swipe works freely (no guard needed).

### Home screen

- [ ] **R95** Live game cards at the top show league name, "Home vs Away"
      matchup, and 📍 location when set.
- [ ] **R96** A game without a location omits the location line cleanly.
- [ ] **R97** Multiple live games become a horizontal carousel.
- [ ] **R98** League search filters the list.
- [ ] **R99** Favourite leagues sort to the top.
- [ ] **R100** Drop-in rows appear only when they have games, and are labelled
      "Community Drop-in Games (Papawis)" and "Private Drop-In Games".
- [ ] **R101** Pull to refresh updates leagues **and** promos.
- [ ] **R102** Onboarding sheet shows on first run and does not return after
      being dismissed.
- [ ] **R103** "Don't have a code? Message us on Instagram" opens your Instagram
      profile (app if installed, browser otherwise).

### Drop-in cleanup and auto-hide

- [ ] **R104** With finished drop-in games present, the "🧹 Clean up old games"
      button appears in the Games tab.
- [ ] **R105** Gating: Private = anyone who can score there. Community =
      Super Admin only. Verify with a non-admin account.
- [ ] **R106** Tap it. *Expect:* a menu with 3 days / 1 week / all finished.
- [ ] **R107** Confirm dialog names the exact count and warns it is permanent.
- [ ] **R108** After cleanup, the chosen games, their teams and their players
      are gone.
- [ ] **R109** A team shared between a deleted and a **surviving** game
      **survives**. This is the important one.
- [ ] **R110** Cleanup never touches a live or in-progress game.
- [ ] **R111** Roster tab: teams whose last finished game is over two weeks old
      collapse into "▸ Older teams (N)", collapsed by default.
- [ ] **R112** Expanding it shows them, and searching still finds them.

---

## P3. Sync, offline and multi-device

Needs two devices, or one device plus airplane mode.

- [ ] **R113** Settings → Sync card reads "● Connected".
- [ ] **R114** Score on device A. *Expect:* device B updates within a second or two.
- [ ] **R115** Create a team on A. *Expect:* appears on B.
- [ ] **R116** Spectator on B watches A's live game: score, play-by-play, fan
      dashboard all update.
- [ ] **R117** Airplane mode: log stats offline. *Expect:* works locally.
- [ ] **R118** Re-enable network. *Expect:* offline stats sync up, nothing lost.
- [ ] **R119** Force-quit mid-game and reopen.
      *Expect:* resume-live-game path works and no stats are lost.
- [ ] **R120** Two devices scoring **different** games at once.
      *Expect:* no interference between them.
- [ ] **R121** Sync badge shows saving → saved, and shows an **error** state if
      a write genuinely fails (do not skip: silent failure is what hid several
      earlier bugs).

---

## P4. Native build only (will not work in Expo Go)

- [ ] **R122** Share an achievement card. *Expect:* a real PNG in the share
      sheet, not a text fallback. Check it in Instagram Stories (portrait) and
      a Facebook feed post (square).
- [ ] **R123** Share the box-score card.
- [ ] **R124** Haptic feedback on stat taps, with the Settings toggle honoured.
      Also confirm iOS Settings → Sounds & Haptics → System Haptics is on.
- [ ] **R125** Team logo and promo image picking from the photo library,
      including the permission prompt.
- [ ] **R126** Final-score notification for a favourited team.
- [ ] **R127** Sign in with Apple end to end.
- [ ] **R128** Settings → Delete account, end to end.

---

## P5. Edge cases and robustness

- [ ] **R129** A team with fewer than five players: can you still start and score?
- [ ] **R130** A game with zero events: box score and final screen do not break.
- [ ] **R131** Very long team and player names across cards, standings and the
      tracker. *Expect:* truncation, not broken layout.
- [ ] **R132** Duplicate jersey numbers on one team. *Expect:* allowed, readable.
- [ ] **R133** Accented and non-Latin characters in names (for example Almeñe).
- [ ] **R134** A tie score at finish. *Expect:* handled sensibly in standings.
- [ ] **R135** Rapid repeated tapping on the stat pad.
      *Expect:* every tap counted once, nothing dropped or doubled.
- [ ] **R136** Rotate the device / check on a small screen.
- [ ] **R137** Dark mode consistency (the app is dark-only by design).
- [ ] **R138** An invalid or already-used creation code.
      *Expect:* a clear error, not a silent failure.
- [ ] **R139** Delete a league that has live games.
- [ ] **R140** Kill the app during a save, reopen, and check nothing is corrupt.

### Admin password backup

- [ ] **R141** On a fresh Supabase project where `set_admin_password` has **not**
      been run, use the hidden lock gesture and enter anything.
      *Expect:* refused. An unset password must not let anyone in - it used to
      grant admin to any caller with any password when the secret row was absent.
- [ ] **R142** Run `select public.set_admin_password('…')`, then unlock with it.
      *Expect:* admin granted; write actions become available.
- [ ] **R143** Enter the wrong password five times.
      *Expect:* a "Too many attempts, try again in N minutes" message, and the
      **correct** password is refused too until the window passes.
- [ ] **R144** Run `set_admin_password` again with a new value.
      *Expect:* any lockout clears, the new password works, the old one does not.
- [ ] **R145** In a local-only build (no Supabase env vars) with
      `EXPO_PUBLIC_ADMIN_LOCAL_PASSWORD` unset, try the lock gesture.
      *Expect:* "No local admin password is configured for this build."

---

## Known limitations (not bugs)

- Push notifications are limited in Expo Go. Use a build.
- Share-card PNG capture does not work in Expo Go (falls back to text). The
  in-app preview still renders, so layout is testable.
- Two scorekeepers on the **same** game will overwrite each other. Last write
  wins by design. Different games never collide.
- Promo changes on other people's devices appear when they next focus Home or
  pull to refresh, not instantly.
