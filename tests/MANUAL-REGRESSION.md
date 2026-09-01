# iTala manual regression checklist

Covers what automation cannot reach: rendering, navigation, gestures, native
modules, real permissions, and multi-device sync. Run `npm test` first, since a
failure there makes most of this moot.

Report failures by id, for example "R14 failed", so the exact case is unambiguous.

**Sections P6 to P9 are new and have never been run.** They cover the accessibility work
(screen reader, P6), the upgrade and migration paths that only reproduce when installing over an
older build (P7), tied-game handling (P8), and the store-submission prerequisites (P9). P6 in
particular is the largest untested surface in the app: the semantics are in place and guarded by
static checks, but no screen reader has ever been pointed at them.

---

## Before you start

- [ ] **P0.1** Re-run `supabase/schema.sql` in the Supabase SQL Editor. Several
      recent fixes depend on new database functions (`rec_setup_game`,
      `bulk_import_roster`). Without this, drop-in games will fail loudly.
      **Order matters now:** the script also carries the retired app-wide
      "track misses" value onto older leagues and then drops the
      `app_settings` table. Run it **before** installing a client build that no
      longer reads that table, or the old value is lost. See P7 (U1 to U4).
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

Also now automated, so do not spend manual time proving them: tied-game
arithmetic in standings (`GROUP M`), the legacy settings migration in the
reducer (`GROUP N`), the presence of accessibility roles and announcements
(`CHECK 14`), the privacy-policy and store-declaration content (`CHECK 15`), and
the SQL backfill itself (`settings_backfill`). What remains manual is whether a
real screen reader **speaks** sensibly, and whether an upgrade over an older
build preserves what it should - neither of which a static check can tell you.

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
- [ ] **R134** A tie score at finish. **Superseded by section P8**, which replaces this with
      twelve specific cases. "Handled sensibly" was too vague to fail: a level score was in fact
      being recorded as a home win.
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

## P6. Accessibility - screen reader (NEW, and the biggest untested surface)

**Nothing here has ever been run.** The semantics are implemented and guarded by
`static.test.js` CHECK 14, but a static check cannot tell you whether VoiceOver or TalkBack say
something sensible, say it in the right order, or say it twice. Until this section passes, treat
accessibility as implemented-but-unverified.

Turn on **VoiceOver** (iOS: Settings → Accessibility → VoiceOver) or **TalkBack** (Android:
Settings → Accessibility → TalkBack). Do the whole section on **both** platforms if you can: the
announcement mechanism differs, and the double-speak risk in A3 is Android-specific.

### The two-tap stat flow (F-05, CRITICAL)

- [ ] **A1** On the live tracker, swipe to a stat pad button and activate it.
      *Expect:* it announces something like "three point make armed. Tap a Warriors player." Not
      "2PT", not silence, and not a spelled-out "✗".
- [ ] **A2** Then activate a player chip.
      *Expect:* "three point make logged for Juan A." The score is announced by nothing else, so
      if this is silent the flow is unusable.
- [ ] **A3** **Android specifically:** confirm each announcement is spoken **once**, not twice.
      The code deliberately uses `announceForAccessibility` and *not*
      `accessibilityLiveRegion="polite"` precisely to avoid a double announcement. If you hear
      everything twice, that decision has been undone somewhere.
- [ ] **A4** Log a full possession without looking at the screen. Arm, tap a player, arm, tap.
      *Expect:* you can tell what was recorded at every step from audio alone.
- [ ] **A5** Activate an already-armed stat button.
      *Expect:* "Stat cleared." and the button no longer reads as selected.
- [ ] **A6** Tap **Undo**. *Expect:* "Undid three point make for Juan A." Not just "Undo".
- [ ] **A7** Tap **Undo** with nothing to undo. *Expect:* "Nothing to undo."
- [ ] **A8** Tap **Redo**. *Expect:* "Redid ..." naming the event.
- [ ] **A9** Log a timeout. *Expect:* "Timeout logged for Warriors, 4:32 remaining" (or without
      the time if you left it blank).
- [ ] **A10** Score enough to trigger a milestone banner (25 points, or a double-double).
      *Expect:* the banner text is spoken. It auto-dismisses after ~2 seconds, so a screen-reader
      user who is not told never knows it happened.

### Roles, labels and state (F-06)

- [ ] **A11** Swipe through the stat pad. *Expect:* every button announces as a **button**, with a
      pronounceable name ("free throw miss", not "FT ✗"), and the armed one announces as
      **selected**.
- [ ] **A12** Swipe to a player chip. *Expect:* one coherent phrase, for example "Number 17,
      Juan A, 13 points, 4 fouls, button". Not four disconnected fragments.
- [ ] **A13** A player one foul from fouling out.
      *Expect:* "one foul from fouling out" is included. On screen this is red text only, so
      without it the warning is invisible non-visually.
- [ ] **A14** With no stat armed, the player chips should announce as **disabled**.
- [ ] **A15** The mini buttons announce as "Undo", "Redo", "Subs", "Court", "Log", "Timeout" -
      **without** the leading glyph being read out as "clockwise open circle arrow" or similar.
- [ ] **A16** A disabled Undo/Redo announces as disabled rather than just being silent.
- [ ] **A17** The team score blocks announce team, score, team fouls and timeouts as one phrase,
      and the active team announces as **selected**.
- [ ] **A18** The exit control announces as "Exit game tracker", not "✕".
- [ ] **A19** Elsewhere in the app: `Button`, `Card`, `Segmented` and `Toggle` all announce a role.
      A Segmented tab announces **selected**; a Toggle announces **checked** or unchecked and
      changes when activated.
- [ ] **A20** A text field announces its label, not just its current value.
- [ ] **A21** The "+ Add player to court" dashed box announces its purpose and the count.

### Accessible delete (F-07)

- [ ] **A22** On Games-on-date as an owner, focus a game card and open the screen reader's
      **actions** menu (VoiceOver: swipe up/down or the rotor; TalkBack: local context menu).
      *Expect:* a **"Delete game"** action is offered.
- [ ] **A23** Activate it. *Expect:* the same confirmation dialog the swipe gesture produces, and
      deleting works.
- [ ] **A24** As a non-owner, the action is **not** offered.
- [ ] **A25** Focus the "Swipe a game to the left to delete it" hint line.
      *Expect:* it reads as "To delete a game, choose the Delete action on that game" - not the
      swipe instruction, which a screen-reader user cannot follow because horizontal swipes are
      consumed for navigation.
- [ ] **A26** Confirm the **swipe gesture still works** with the screen reader off. The accessible
      path was added alongside it, not instead of it.
- [ ] **A27** Each game card announces one coherent summary: matchup, status, both scores.

### Known gaps (do not report these as failures)

- **F-20** colour-only risk cues: foul danger is now in the *spoken* label but there is still no
  non-colour **visual** cue. Open.
- **F-21** touch targets below the guideline size on live-game controls. Open.
- **F-25** icon-only buttons on screens other than the live tracker, and the box-score table's
  lack of table semantics. Only partly addressed.

---

## P7. Upgrade and migration paths (NEW)

These only reproduce by installing a **new build over an older one**. A fresh install passes
trivially and proves nothing, which is exactly why they need to be manual.

### Legacy app-wide "track misses" setting (N-06)

The app-wide toggle is gone; stat tracking is per-league with a per-game override. The old global
value has to be carried onto leagues that predate the per-league column. Get this wrong and a
scorekeeper who turned misses **off** finds them switched back **on**.

- [ ] **U1** **Server first.** Re-run `supabase/schema.sql` on the project, then check
      `select count(*) from leagues where track_misses is null;`
      *Expect:* **0**. Do this **before** installing the new client. If you install the client
      first the old global is gone and the value cannot be recovered.
- [ ] **U2** Same query for `track_turnovers is null`. *Expect:* 0.
- [ ] **U3** Confirm `app_settings` no longer exists:
      `select to_regclass('public.app_settings');` *Expect:* null.
- [ ] **U4** Re-run `schema.sql` a **second** time. *Expect:* no error. It is documented as safe to
      re-run, and the migration is guarded for the case where the table is already gone.
- [ ] **U5** **Local-only device.** On a device running the **old** build with no Supabase config,
      set up a league and turn miss tracking **off**. Install the new build over it.
      *Expect:* that league still hides the miss row. This is the case the server backfill cannot
      reach, handled by a one-shot read in `HYDRATE`.
- [ ] **U6** Same as U5 but with miss tracking left **on**. *Expect:* still on.
- [ ] **U7** After upgrading, change a league's miss setting in League settings and confirm it
      still round-trips to the server and to a second device.
- [ ] **U8** A drop-in game created with per-game toggles still overrides its league setting.

### Android permissions (F-10)

- [ ] **U9** In a **new native build**, check the app's permission list in system settings.
      *Expect:* **no Microphone and no Camera** entry. `expo-image-picker` used to add both.
- [ ] **U10** Pick a team logo from the photo library. *Expect:* the photo-library prompt appears
      and the picker works. Only the microphone and camera were blocked, not photos.
- [ ] **U11** Pick a sponsor promo image the same way.
- [ ] **U12** If you have a built `.aab`/`.apk` to hand, confirm no `RECORD_AUDIO` or `CAMERA` in
      its merged manifest. Introspection (`npx expo config --type introspect`) shows
      `tools:node="remove"` on both, but that has not been confirmed against a real build.

---

## P8. Tied games (F-11) - re-test, replaces R134

`R134` ("a tie score at finish, handled sensibly") was too vague to fail. A level score used to be
recorded as a **home win**. It is now a draw, and a 0-0 game marked final takes the same path, so
this is reachable without anyone mis-tapping.

- [ ] **T1** Play a game to a level score and finish it. Check Standings.
      *Expect:* **neither** team gains a win or a loss. Both show a tie.
- [ ] **T2** The standings record column reads **W-L-T**, and the tied game shows in the T column.
- [ ] **T3** The streak column shows `T1` for both teams, not `W1`/`L1`.
- [ ] **T4** PCT treats the draw as half a win, and the value agrees with where the row sits in the
      table. A PCT that contradicts the sort order is the bug.
- [ ] **T5** Create a game and mark it **final with no stats at all** (0-0).
      *Expect:* a tie, not a home win. This used to give home a win **and** away a loss.
- [ ] **T6** Team profile for a team with a draw: RECORD reads W-L-T, and **PPG / OPP PPG are not
      inflated**. Ties now count toward games played; they used to be excluded while the drawn
      game's points still counted (N-03).
- [ ] **T7** Box score of a tied game: **both** team names and both scores are highlighted, not
      just the home side.
- [ ] **T8** Games-on-date card for a tied game: both rows highlighted equally.
- [ ] **T9** Final Score screen for a tie: the "It's a tie!" message, no trophy line.
- [ ] **T10** Player of the Game on a tie is drawn from **both** teams, so the best performer on
      the away side can win it. It used to silently come from the home team only (N-04).
- [ ] **T11** Share an achievement card from a tied game and confirm Player of the Game agrees
      with T10.
- [ ] **T12** **Regression guard:** a normally decided game is completely unaffected. Winner gets
      the win, loser the loss, streaks W1/L1, winner sorted first, T column 0.

---

## P9. Store submission prerequisites (NEW, not app behaviour)

- [ ] **S1** Privacy policy deployed and loading over HTTPS (see `site/README.md` for the
      Cloudflare Pages setup).
- [ ] **S2** Every `[OPERATOR]` and `[CONTACT EMAIL]` placeholder replaced, and the orange
      "before publishing" notice deleted from `site/privacy/index.html`.
- [ ] **S3** The contact address actually receives mail. It is the only route by which someone who
      never installed the app can have their name removed.
- [ ] **S4** Policy URL pasted into **both** store listings.
- [ ] **S5** Policy content read side by side with the two declaration tables in `DEPLOYMENT.md`
      and confirmed to agree.
- [ ] **S6** Location **not** declared on either store form.
- [ ] **S7** Sponsor promo taps **are** declared (Apple Usage Data, Google App activity).
- [ ] **S8** A position taken on children's data: age rating, Play target audience, and the policy
      section consistent with each other.


## P10 - live-score consistency, sign-in, and the drop-in flow (NEW, never run)

Automation covers the logic (`tests/sync.test.js` S9-S17, `tests/reducer.test.js`
R1-R26) against a latency-modelling server emulator. What it cannot cover is a
real network, a real Supabase project, and a real thumb. These are the cases
those fixes were written for, so they are the ones worth a device.

### Score consistency
- [ ] **T1** Log a 3PT. The score goes up by 3 **and stays there** - no revert a
      few seconds later, no jump to 6 afterwards.
- [ ] **T2** With a second device watching the same game, log stats quickly on
      the first. Both settle on the same score, and neither flickers backwards.
- [ ] **T3** Turn wifi **off**. Log three stats. Each appears and stays; the sync
      badge goes red. Turn wifi back on and pull to refresh - the three stats are
      still there and the score is unchanged.
- [ ] **T4** Undo three times quickly, then Redo three times quickly. The score
      lands where it started, and no in-between value survives.
- [ ] **T5** Undo a stat, then immediately log a different one. The undone stat
      does not come back.

### Sign-in
- [ ] **T6** In **Expo Go** with the `exp://...` URL from the Metro log added to
      Supabase → Authentication → URL Configuration → Redirect URLs: Google
      sign-in completes and returns to the app.
- [ ] **T7** Without that entry: the browser fails to come back, and the app says
      so and prints the URL to add - it no longer looks like a Safari error with
      no explanation. (Worth doing once, to confirm the message.)
- [ ] **T8** In a **development or preview build**: Google sign-in completes with
      no allowlist entry at all (its redirect is `itala://auth-callback`, which is
      the Site URL).
- [ ] **T9** Apple sign-in in a build. In Expo Go it only works while
      `host.exp.Exponent` is in the provider's Client IDs; without it the app
      explains the bundle-id mismatch rather than reporting a network error.
- [ ] **T10** Fail a sign-in (aeroplane mode). Close the sheet. Tap the wordmark
      ten times and open Admin access. **The sign-in error must not be in that
      modal.**
- [ ] **T11** Put the device in aeroplane mode and relaunch the app while signed
      in. When the network returns you are **still signed in** - the app must not
      have quietly dropped you to a guest session.

### Drop-in games
- [ ] **T12** As the backup admin (wordmark x10, password), create a drop-in
      game. It saves.
- [ ] **T13** In aeroplane mode, create a drop-in game. The alert says nothing
      was saved, and the game is **not** in the list afterwards.
- [ ] **T14** Same, but into a drop-in space that already has games in it: only
      the failed game disappears, the space and its earlier games survive.

### Play-by-play and titles
- [ ] **T15** Open the play-by-play. Every line shows the team badge and name.
- [ ] **T16** Tap the ✕ on a line. A confirmation names the play. Cancel changes
      nothing; confirm applies the change to the score.
- [ ] **T17** Walk the whole app. No screen shows a route name (for example
      "LeagueDetail") in the header or the iOS back button.

## Known limitations (not bugs)

- Push notifications are limited in Expo Go. Use a build.
- Share-card PNG capture does not work in Expo Go (falls back to text). The
  in-app preview still renders, so layout is testable.
- Two scorekeepers on the **same** game will overwrite each other. Last write
  wins by design. Different games never collide.
- Promo changes on other people's devices appear when they next focus Home or
  pull to refresh, not instantly.
