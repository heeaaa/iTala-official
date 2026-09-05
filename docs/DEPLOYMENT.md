# Deploying iTala to the App Store & Google Play

This guide takes the project from source code to live in both stores using **EAS**
(Expo Application Services) — Expo's hosted build + submit pipeline. EAS lets you build iOS
apps **without a Mac**, since the compile happens on Expo's cloud macOS machines.

> Verified against the current process as of mid-2026 (Expo SDK 55 era, EAS CLI ≥ 16). Fees and
> store policies change — confirm anything money- or policy-related on the official pages linked
> at the bottom before you rely on it.

---

## 0. Prerequisites & costs

| What you need | Cost | Notes |
|---|---|---|
| Apple Developer Program | **$99 / year** | Required to ship to the App Store / TestFlight. |
| Google Play Developer account | **$25 one-time** | Required to ship to Google Play. |
| An Expo account | Free | Sign up at expo.dev. |
| Node.js 20+ and this repo | Free | `npm install` already run. |

**Three policy gotchas that will bite you if you don't plan for them:**

1. **Google Play 12-testers rule.** If your Google Play account is a **personal** account created
   after Nov 13, 2023, you cannot publish to production until you've run a **closed test with at
   least 12 testers opted in for 14 continuous days**. Organization accounts are exempt. Plan two
   extra weeks, or register as an organization. Start recruiting testers on day one.
2. **Apple privacy details.** App Store Connect makes you fill in "privacy nutrition labels."
   A synced build of iTala **does collect data** — it has accounts and it stores rosters on a
   server — so "Data Not Collected" is not available to you. Declare:

   | Category | What it is in iTala | Linked to user? | Purpose |
   |---|---|---|---|
   | Contact Info → Email Address | Google/Apple sign-in identity | Yes | App Functionality |
   | Contact Info → Name | Account display name from the provider | Yes | App Functionality |
   | User Content → Photos or Videos | Google/Apple profile photo, team logos, sponsor promo images | Yes | App Functionality |
   | User Content → Other User Content | **Player names, jersey numbers and per-player stats** entered onto rosters, team and league names, and the **free-text venue** typed onto a game | Yes | App Functionality |
   | Identifiers → User ID | Supabase auth UUID (including anonymous sessions) | Yes | App Functionality |
   | Usage Data → Advertising Data | **Sponsor promo tap counts.** `onPromoTap` calls the `bump_promo_tap` RPC, which runs `update promos set taps = taps + 1`: an aggregate counter per promo, no user id stored | No | Analytics |

   Answer **No** to the tracking question. Nothing is combined with third-party data or used for
   cross-app tracking, so the app needs no App Tracking Transparency prompt.

   **Do not declare Location.** `games.location` is a venue name somebody types in. There is no
   `expo-location` dependency and the app requests no location permission, so Apple's *Location*
   and Google's *Approximate/Precise location* categories, both of which mean **device**
   location, would be false in the opposite direction. The venue text is declared above under
   User Content, which is where it belongs. Worth stating explicitly because it can name a
   private address, and because "we store a location field" is the obvious wrong guess here.

   Google Play's **Data safety** form asks the same questions in a different shape:

   | Data type | Collected | Shared | Required? | Purpose |
   |---|---|---|---|---|
   | Personal info → Email address | Yes | No | Required to sign in | App functionality, Account management |
   | Personal info → Name | Yes | No | Required to sign in | App functionality, Account management |
   | Personal info → User IDs | Yes | No | Required | App functionality |
   | Photos and videos → Photos | Yes | No | Optional | App functionality |
   | App activity → App interactions | Yes | No | Required | Analytics (sponsor promo tap counts) |
   | Other → Other user-generated content (roster content, team and league names, venue text) | Yes | No | Required | App functionality |

   Also on that form: **encrypted in transit - Yes** (everything reaches Supabase over
   HTTPS/WSS); **users can request data deletion - Yes**, which the app already supports through
   Settings → Delete account (the `delete_own_account` RPC), and the privacy policy has to say
   so and how. **Shared - No** throughout: Supabase, Google and Apple are service providers
   processing data on your behalf, which Play's definition of "shared" excludes.

   **Permissions.** `expo-image-picker` adds `RECORD_AUDIO` and `CAMERA` to the Android manifest
   by default, for video capture this app never does - it only calls `launchImageLibraryAsync`
   with `MediaTypeOptions.Images`. `app.json` therefore passes `microphonePermission: false` and
   `cameraPermission: false`, which emits `tools:node="remove"` so the manifest merger strips
   both from the build. Declaring a microphone permission you have no feature for is a Data
   safety answer you cannot justify. Note that deleting the entry from `android.permissions`
   does **not** work on its own; the plugin adds it straight back.

   The roster row is the one that is easy to get wrong: a scorekeeper types in the names of
   *other people*, who never installed the app and never consented, and those names sync to
   Supabase and are readable by every signed-in session. That is third-party personal data. It
   is what makes "offline-only, nothing collected" false the moment sync is switched on, and it
   is why the app needs a real privacy policy URL saying who can see a roster and how to get a
   name removed. Declaring "Data Not Collected" while shipping a login and a server-side roster
   is a rejection/removal reason — keep these truthful.

   **Children's data.** Youth basketball rosters mean children's names and performance stats sit
   on a server, entered by an adult. Decide a position on this before submitting: it drives the
   age rating, Google Play's target-audience declaration, and a section the privacy policy needs.
   The app is not directed at children, but it stores data *about* them, and those are different
   questions on both forms.

   A **local-only build** (no `EXPO_PUBLIC_SUPABASE_*` values, no sign-in, nothing leaves the
   device) genuinely collects nothing. If you ever ship that variant, it gets its own labels —
   don't reuse these.
3. **Sign-in feature compliance (already implemented in this codebase).** Because the app offers
   Google sign-in: (a) iOS must also offer **Sign in with Apple** (Guideline 4.8) — included, via
   `expo-apple-authentication`; enable the Apple provider in Supabase per `AUTH_SETUP.md` before
   submitting; (b) both stores require **in-app account deletion** — included, in Settings →
   Danger zone (backed by the `delete_own_account` function in `supabase/schema.sql`; re-run the
   schema so it exists). Also set the Supabase **Site URL** to `itala://auth-callback` for
   production builds.

---

## 0.5. (Optional) Multi-device sync via Supabase

If you'll run more than one device live at the same time — e.g. two scorekeepers at two
courts, plus people watching — set this up before shipping. Without it, each device's data
stays on that device.

### Provision the database

1. Create a project at <https://supabase.com>. The free tier covers two simultaneous live
   games with spectators easily (500 MB database, 200 concurrent realtime connections, 2M
   realtime messages/month).
2. In Project Settings → Authentication → Providers → **Anonymous**, toggle it **on**.
   This is what lets a spectator's phone get a session without account creation.
3. Open SQL Editor → New query, paste the contents of `supabase/schema.sql` from this repo,
   and Run. It's idempotent — safe to re-run.
4. **Set the admin password** — new projects only. `schema.sql` ships with the secret unset,
   and while it is unset the password backup refuses every attempt. In SQL Editor:
   ```sql
   select public.set_admin_password('«the password»');
   ```
   Run it again any time to change the password; that also clears any active lockouts.

   **Upgrading a project that predates the hashed secret?** Just re-run `schema.sql`. It
   migrates `admin_secret` in place: your existing password is converted to a bcrypt hash and
   the plaintext column is dropped, so the *same password keeps working* and you don't need
   this step. Watch for the notice `admin_secret: existing password migrated to a bcrypt
   hash; plaintext column dropped.` in the SQL Editor output. Re-running afterwards is a
   no-op — it will not clear the hash.

   One thing re-running does **not** fix: a password that was committed to a public repo is
   still in that repo's git history, and hashing it now does not un-publish it. Rotating with
   `set_admin_password` is the only thing that does.

   Why it works this way. The secret is stored as a **bcrypt hash** in a table with no RLS
   policies, so no client can read it under any key — but that was never the exposure. The
   exposure is `elevate_to_admin` itself: it must be callable by anonymous sessions (the hidden
   unlock gesture happens before the caller is anybody), and the anon key is inlined into the JS
   bundle, so anyone who unpacks the app can call the function directly, from anywhere, as fast
   as the network allows. That is why it counts failures and locks a session out for 15 minutes
   after 5 wrong guesses, and why the password must never be written into this repo — a password
   in git history stays published even after you delete the line.

   Day-to-day admin should come from the Google/Apple allowlist (`admin_emails` in the schema,
   `ADMIN_EMAILS` in `src/store/AdminProvider.tsx`), not from this password.

### Configure the app

Copy `.env.example` to `.env` and fill in your project URL and anon key (Project Settings →
API). For EAS builds, set these as **EAS Secrets** so they're injected at build time:

```bash
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_URL --value https://YOURPROJECT.supabase.co
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value eyJhbGciOi...
```

The anon key is safe to ship in the binary in the sense that it grants no privileges of its
own — row-level security is what actually protects writes. Treat it as public, because it is:
Metro inlines `EXPO_PUBLIC_*` values into the bundle, so anything named that way is readable by
anyone who unpacks the app. Never put a secret behind an `EXPO_PUBLIC_` name.

Who can write, as the schema actually stands: a league's **owner** (settings, roster, teams,
delete), its **scorekeepers** (stats, lineups, games), any signed-in user on a **shared
recreational** league, the **creator** of a community drop-in game for that game, and a **Super
Admin** everywhere. Anonymous spectator sessions can SELECT and nothing else. `is_admin` is the
Super Admin flag only — it is not what ordinary scorekeeping runs on.

### Keep the project from auto-pausing

Supabase free projects pause after 7 days of inactivity. For a weekly Saturday league, this
will absolutely bite you mid-season. The repo includes `.github/workflows/supabase-keepalive.yml`,
a GitHub Action that pings the database every 3 days.

To enable it:
1. Push this repo to GitHub.
2. Repo Settings → Secrets and variables → Actions → New repository secret. Add:
   - `SUPABASE_URL` = `https://YOURPROJECT.supabase.co`
   - `SUPABASE_ANON_KEY` = your anon key
3. Actions tab → "Supabase keep-alive ping" → Run workflow once to verify it works
   (it should print `HTTP 200`).

If you don't want to use GitHub, point a free uptime monitor (UptimeRobot, Cronitor, etc.) at:
`POST https://YOURPROJECT.supabase.co/rest/v1/rpc/ping` with the headers
`apikey: <anon>` and `Authorization: Bearer <anon>`, body `{}`, anything weekly or more often.

### How to verify it's working

After setup, on each device open Settings (admin only) — the Sync card should say
**● Connected**. Open the app on two devices, unlock admin on both, start a game on one,
and watch stats appear on the other within a second.

### Known tradeoffs

- **Last write wins.** Two scorekeepers should not be on the same game at the same time.
  If they are, the later write overwrites the earlier. Different games — including the two
  parallel-court use case — never collide.

---

## 1. One-time project prep

### 1a. Expo SDK
This project targets **Expo SDK 54** (React Native 0.81 / React 19), which runs in the current
Expo Go. That's recent enough for store submission today. If a newer SDK has shipped by the time
you submit and you want to move up, run:

```bash
npm install expo@latest
npx expo install --fix     # realigns every native dependency to the new SDK
npx expo-doctor            # sanity-check the project
```

### 1b. Set your real bundle identifiers
The app ships with `com.bpbl.itala` in **both** `ios.bundleIdentifier` and
`android.package`. To publish under your own account, replace it with your reverse-domain id
(e.g. `com.yourname.itala`). This id is
permanent once published — choose carefully.

### 1c. Install the EAS CLI and log in
```bash
npm install -g eas-cli      # or use `npx eas-cli@latest` everywhere below
eas login
```

### 1d. Link the project to EAS
```bash
eas init
```
This creates/links an EAS project and writes the real `projectId` into `app.json`
(replacing the `REPLACE_WITH_YOUR_EAS_PROJECT_ID` placeholder). The included `eas.json`
already defines `development`, `preview`, and `production` build profiles.

---

## 2. Test on real devices first (do not skip)

``` bash
# If you have a zip file of the workspace, unzip and merge automatically using these
Expand-Archive -Path iTala-project.zip -DestinationPath itala-incoming -Force
robocopy itala-incoming\iTala iTala /MIR /XD .git node_modules
cd iTala
```

A simulator hides real-device issues (fonts, share sheet, storage). Build an internal-distribution
binary and install it on your phone:

```bash
# Android — produces an installable .apk you can sideload
eas build --platform android --profile preview

# iOS — installs via the QR/link on devices registered to your Apple account
eas build --platform ios --profile preview
```

While online, create a league, add two teams and players, and start a game. Confirm setup
has synchronized before enabling airplane mode. Log a quarter of stats with the two-tap
pad, then close and reopen the app while the game is still live. Confirm the
**resume-live-game** banner appears and the unsynced stats remain. Reconnect and verify
the sync status confirms saving and another device sees the same stats. Finish the game,
check standings/leaderboards, and tap **Share box-score card**. Separately verify drop-in
game creation while online. Offline setup is not part of the supported synced workflow.

---

## 3. Build for production

```bash
# Build both platforms at once
eas build --platform all --profile production
```

EAS handles signing credentials for you the first time (let it generate and manage them — say yes
to the prompts). For iOS it creates a distribution certificate + provisioning profile; for Android
it generates an upload keystore. Builds run in the cloud; you'll get a link to each artifact
(.ipa for iOS, .aab for Android).

---

## 4. Apple App Store submission

### 4a. Create the app record in App Store Connect
1. Go to App Store Connect → **Apps → + → New App**.
2. Platform iOS, pick your bundle id, set the name "iTala" (must be globally unique — have a
   backup like "iTala — Stat Tracker" ready).
3. After creating it, open **General → App Information** and copy the **Apple ID** number — that's
   your `ascAppId`. Paste it into `eas.json` under `submit.production.ios.ascAppId` (optional but
   makes submits non-interactive).

### 4b. Submit the build
```bash
eas submit --platform ios --profile production --latest
```
EAS uploads the build to App Store Connect. After processing (10–30 min) it appears under
**TestFlight** and is selectable for App Store review.

### 4c. Complete the listing, then submit for review
In App Store Connect fill in: description, keywords, support URL, **screenshots** (6.7" iPhone
required, capture from a device or simulator), the **privacy nutrition labels** (see the tables in
prerequisite gotcha #2: email, name, photos, roster content and venue text, user ID, all linked to
the user and all App Functionality; plus sponsor promo tap counts as Usage Data, not linked; no
tracking), a **privacy policy URL** (required, and it has to cover roster data about people who
are not app users, who can read a roster, and how to get a name removed - `site/privacy/` does,
and is filled in and ready to publish; it deploys from this repo via `wrangler.jsonc` - see
`site/README.md` - so paste the deployed `/privacy/` URL here **and** in the Play listing),
age rating, and category (**Sports**). Attach the
build, then **Submit for Review**.
Apple review typically takes 1–3 days.

**Likely reviewer questions for this app:** the reviewer must be able to exercise sign-in and see
real content. Create a dedicated Google test account and provide its email and password privately
in App Store Connect's App Review Information sign-in fields. In Review Notes, direct reviewers
to **Sign in with Google** using that account, and supply fresh single-use League Creation Codes
privately so they can create and own a test league, manage rosters, and score games. Verify the
account works on a clean device without developer intervention, and keep unused backup codes
available for repeat testing. Explain guest, named-user, scorekeeper, owner and platform-admin
roles; the test account only needs regular named-user access before creating its league.
Pre-seed a demo league so guest browsing isn't empty (use made-up player names, not real ones).
Keep credentials and codes out of the repository; invalidate any previously published unused
codes before supplying replacements. Follow the access checklist in `docs/APP_REVIEW.md`.

There are no payments, social feed, comments, reactions or direct messages. League owners can,
however, publish roster information, team logos, photographs and sponsor material that concerns
or belongs to other people. The app therefore provides **Report this information** on player,
team, league and box-score screens. Reports go to the private `content_reports` review queue and
return a reference number; the Content Policy also provides email reporting and correction
routes. Point the reviewer to this flow explicitly. Do not claim automated filtering or user
blocking exists when it does not. See `docs/APP_REVIEW.md` for the complete reviewer walkthrough.

---

## 5. Google Play submission

### 5a. Create the app + first manual upload
Google requires your **first** upload to be done by hand before EAS API submissions work.
1. Google Play Console → **Create app** → name "iTala", category **Sports**, free.
2. Build the Android binary if you haven't: `eas build --platform android --profile production`,
   then download the `.aab` from the EAS build page.
3. In Play Console go to **Testing → Closed testing → Create release**, upload the `.aab`, and roll
   it out to your closed-testing track.

### 5b. Run closed testing (the 12-testers / 14-days gate)
1. Add at least **12 testers** (their Google account emails) to the closed test and share the
   opt-in link.
2. They must install via the link and **stay opted in for 14 continuous days**. Shipping a small
   update during the window is a positive signal to Google and doesn't reset the clock.
3. After 14 days, the Console **Dashboard** shows an **"Apply for production access"** action.
   Fill out the short questionnaire about your testing.

### 5c. Set up API submissions for future updates
Create a **Google Service Account Key** (Play Console → Setup → API access) and save the JSON.
Point `eas.json` at it, e.g.:
```json
"submit": { "production": { "android": { "serviceAccountKeyPath": "./play-service-account.json", "track": "production" } } }
```
Then future releases are one command:
```bash
eas submit --platform android --profile production --latest
```
> Keep the service-account JSON out of git — add it to `.gitignore`.

### 5d. Production release
Once production access is granted, promote the build to the **Production** track, complete the
store listing (description, screenshots, feature graphic, the **Data safety form**: fill it in
from the Play table in prerequisite gotcha #2; this app *does* collect data, so do not declare
"no data collected", and do not declare Location either),
content rating questionnaire, and submit. Google review is usually hours to a couple of days.

---

## 6. Shipping updates afterward

For each new version:
1. Bump `version` in `app.json` (e.g. `1.0.0` → `1.0.1`). EAS auto-increments the native
   build/version codes because `eas.json` production has `autoIncrement: true`.
2. `eas build --platform all --profile production`
3. `eas submit --platform all --profile production --latest`

For JS-only changes (no native modules added), you can push instant **over-the-air updates** with
`eas update` instead of a full store resubmission — add `expo-updates` and run
`eas update:configure` first.

You can also combine build + submit in one step with `eas build --platform all --auto-submit`.

---

## 7. Pre-submission checklist

- [ ] Real bundle identifiers set in `app.json` (not `com.yourcompany.*`)
- [ ] App icon (1024²) and splash present in `assets/` — included; swap for your own branding if desired
- [ ] Tested on a physical iPhone **and** Android phone via a `preview` build
- [ ] Verified online setup, connection loss during live scoring, resume-live-game, and synchronization after reconnecting
- [ ] Screenshots captured for both stores
- [ ] Apple privacy labels + Google Data safety form filled in from the two tables in prerequisite gotcha #2: email, name, photos, **roster content (player names/numbers/stats)**, team/league names, **venue text** and user ID: all App Functionality, linked to user; plus **sponsor promo tap counts** as Usage Data → Advertising Data / App activity → App interactions, *not* linked. No tracking. Not "Data Not Collected": the app has accounts and server-side rosters
- [ ] **Location NOT declared** on either form: the venue is user-typed text, not device location, and the app has no location permission or dependency
- [ ] Data safety: encrypted in transit **Yes**, deletion requests **Yes** (Settings → Delete account)
- [ ] `microphonePermission: false` and `cameraPermission: false` on the `expo-image-picker` plugin in `app.json`, so `RECORD_AUDIO`/`CAMERA` are stripped from the manifest (`node tests/run.js` checks this; confirm with `npx expo config --type introspect`)
- [ ] Privacy policy deployed and its URL pasted into **both** store listings. Source is `site/privacy/index.html`, published by the Cloudflare Worker `itala` from `wrangler.jsonc` (assets directory `site`, no build step). Confirm the deployed URL actually loads - it is the one link a store reviewer will click
- [ ] Privacy policy content re-checked against the declaration tables so the three cannot drift, and it states plainly that **any signed-in session, including anonymous spectators, can read every roster** (that is what the `read_all_*` RLS policies do)
- [ ] Position taken on children's data (age rating + Play target audience + a policy section)
- [ ] Admin password live on the production project — either `select public.set_admin_password('…')` on a new project, or re-run `schema.sql` on an existing one (which migrates the old plaintext to a hash and keeps the same password). Verify by actually unlocking on a build
- [ ] No password literal anywhere in the repo or in an `EXPO_PUBLIC_*` variable (`node tests/run.js` checks this)
- [ ] Apple provider enabled in Supabase (bundle ID `com.bpbl.itala` in Client IDs) — Sign in with Apple works on a device build
- [ ] Remove `host.exp.Exponent` from the Apple provider's Client IDs — it's a dev-only entry that lets Apple sign-in work inside Expo Go; real builds present `com.bpbl.itala` and must not keep the Expo Go audience allowlisted
- [ ] Settings → Delete account verified end-to-end on a build (schema re-run so `delete_own_account` exists)
- [ ] **`supabase/schema.sql` re-run against production.** Beyond the admin password and `delete_own_account`, `rec_setup_game` now admits a password-elevated Super Admin (its session is anonymous, which the old `is_authed_user()` gate refused). Without the re-run the backup admin can fill in two rosters and only then be told the game did not save
- [ ] **Drop-in game started end-to-end on a build**, both as a signed-in user and as the backup admin. A failure here now rolls the local game back rather than leaving a half-created one in the list, so the symptom is an honest error rather than a game that opens and refuses every write
- [ ] Supabase Site URL set to `itala://auth-callback` (not a dev exp:// URL). A build's redirect **is** this URL, so Google sign-in needs no allowlist entry; the `exp://*` entries are for Expo Go only and can stay
- [ ] Google **and** Apple sign-in both completed on a real build, not in Expo Go. Expo Go cannot exercise either faithfully - see docs/TROUBLESHOOTING.md
- [ ] Category set to **Sports**; age rating completed
- [ ] (Google personal account) 12 testers recruited for the 14-day closed test

---

## Official references
- EAS Build: https://docs.expo.dev/build/introduction/
- EAS Submit: https://docs.expo.dev/submit/introduction/
- Submit to the App Store: https://docs.expo.dev/submit/ios/
- Submit to Google Play: https://docs.expo.dev/submit/android/
- Google Play testing requirements: https://support.google.com/googleplay/android-developer/answer/14151465
- Apple Developer Program: https://developer.apple.com/programs/
