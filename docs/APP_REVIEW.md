# App Review preparation

Use this checklist to prepare iTala's App Store Connect Review Information. It is
not evidence that a particular build has passed review.

Do not commit reviewer credentials, League Creation Codes, recovery codes, private
video links or production secrets to this file. Replace the placeholders directly in
App Store Connect.

## Reviewer information to prepare

### App purpose

iTala is a basketball scoring and league-management app for local, amateur,
recreational and community competitions. Scorekeepers record a game live; the app
derives box scores, play-by-play, standings, leaderboards and player records from those
events. League owners manage teams and rosters, while spectators can follow published
results.

### Test access

Create a dedicated Google test account for App Review. Supply its email and password
privately in App Store Connect's App Review Information sign-in fields, and explain in
Review Notes that these credentials are used through the app's **Sign in with Google**
flow. Reviewers do not need to use a personal Google or Apple account.

Generate fresh single-use League Creation Codes and supply them directly in the private
Review Notes. Only one code is required to create a league; provide unused backups for
repeat testing. Keep the account as a regular named user: a creation code grants ownership
of the new league and the access needed for roster management and scorekeeping.

Before submission, test the supplied Google account on a clean device with the submitted
build. Confirm sign-in and any Google verification prompts can be completed using the
provided materials without approval on a developer's phone. Test league creation with a
separate code so the reviewer codes remain unused. Confirm access remains available for
the entire review, including repeat sign-in after testing in-app account deletion.

Invalidate any still-unused codes previously published in the repository and generate
replacements privately. Removing a code from this file does not revoke it or remove it
from Git history. Never put replacement codes or the test account's credentials here.

### Backend readiness

The submitted build's Supabase project must remain available for the entire review:

- Anonymous sign-in is enabled.
- Google and Apple providers are enabled for the production bundle identifier.
- The production schema has been applied.
- At least one League Creation Code remains unused and can be redeemed.
- A sample league with teams, players, games and statistics loads at launch.
- Legal and support pages load without authentication.
- No test depends on a developer's phone, local network or manually running process.

Use fictional names, teams and images in the demonstration league unless permission to
use real material has been documented.

## Suggested reviewer walkthrough

Keep the final Review Notes shorter than this operational checklist, but make the route
to every important capability explicit.

1. Launch iTala and allow the initial synchronized data load to finish.
2. Open the profile control, choose **Sign in with Google**, and use the dedicated test
   account supplied privately in App Store Connect.
3. Browse the sample league to view its games, standings, leaders and roster.
4. Choose the option to create or join a league using a code and redeem one unused
   League Creation Code from the Review Notes.
5. Create the new league and add or edit teams and players.
6. Create a scheduled or live game, select participating players and choose the starting
   lineup.
7. Start the game, record statistics on the live scorekeeping screen, then finalize it.
8. Confirm the resulting box score, player statistics, standings and shareable stat cards.
9. Open a player, team, league or box-score screen, scroll to **Report this
   information**, select a reason and submit. The confirmation should show a reference
   number. Explanation and contact email are optional.
10. Open the profile control, choose **Settings**, and locate **Delete account** in the
    danger section. Account deletion removes the authentication identity and iTala
    profile; shared league, roster, game and statistical records are retained for other
    league members.

## Roles to explain

| Role | Review-relevant behavior |
| --- | --- |
| Guest | Uses an anonymous Supabase session and can browse synchronized spectator content. |
| Named user | Signs in with Google or Apple and can use account-backed features. |
| Scorekeeper | Can run and update games for leagues where access was granted. |
| League owner | Can administer that league, its membership, teams and roster. |
| Platform administrator | Can perform platform-support operations across leagues. |

The redeemed League Creation Code grants the reviewer the access needed to create a
league and test scorekeeping. Do not require a developer to approve an invitation.

## User-generated content and safety

iTala does not provide a social feed, direct messaging, public comments or reactions.
League owners can, however, publish roster information, team logos, photographs and
sponsor material that concerns or belongs to other people.

The submitted build provides **Report this information** on player, team, game and
league-related screens. A report records its content context and reporter, accepts one
of the supported privacy/content reasons, and returns a reference number. Reports enter
a private Supabase review queue with `New`, `Reviewing`, `Resolved` and `Rejected`
states. The Content Policy also provides email-based reporting and correction routes.

Review Notes should say this plainly and point Apple to step 9 above. Do not claim that
automated filtering, user blocking or public social moderation exists when it does not.

### Review risk to assess before submission

Apple may apply its full user-generated-content requirements when an app lets people
publish information about other people. iTala has reporting and published support
contacts, but it does not currently provide a user-blocking control. The app also has no
user-to-user messaging, comments, reactions or social feed, so blocking has no obvious
interaction surface. Explain that limited content model accurately in Review Notes;
do not imply that reporting replaces a requirement if App Review specifically asks for
blocking or additional moderation controls. Treat such a request as an application change,
not a documentation workaround.

## Account and privacy controls

Explain the following in Review Notes:

- Google sign-in is accompanied by Sign in with Apple on iOS.
- Guest browsing does not require a named social account.
- Named accounts can be deleted inside the app through **Settings → Delete account**.
- Synced league and roster information is visible to valid app sessions, including
  anonymous spectator sessions.
- Content reporting does not require the reporter to provide an optional explanation or
  contact email.
- The app does not request location, camera, microphone or contacts access. Photo-library
  access is optional and used only when selecting a team logo or sponsor image.
- Notifications are local; iTala does not obtain an Expo push token.
- The app contains no in-app purchases or subscriptions.

Ensure the App Store privacy answers remain consistent with `site/privacy/index.html`,
the production schema and the declaration table in [Deployment](DEPLOYMENT.md).

## External services

List the services used by the submitted build:

- **Supabase:** authentication, PostgreSQL storage and Realtime synchronization
- **Google:** optional Google account authentication
- **Apple:** Sign in with Apple and App Store distribution
- **Expo / EAS:** application framework and build service
- **Cloudflare:** static landing, legal and support pages

If the submitted build adds analytics, crash reporting, advertising or another external
service, update this section, the privacy policy and App Store privacy answers together.

## Regions and regulated activity

No region-specific feature branch was found in the application source. Before
submission, confirm that authentication, Supabase and the support/legal site are
available in every selected storefront. iTala is a sports scorekeeping tool and does not
offer gambling, financial, medical or other regulated services.

## Public URLs

Replace these placeholders with the deployed HTTPS pages in App Store Connect:

- Support URL: `[HTTPS_SUPPORT_URL]`
- Privacy Policy URL: `[HTTPS_PRIVACY_URL]`
- Terms of Use: `[HTTPS_TERMS_URL]`
- Content Policy: `[HTTPS_CONTENT_POLICY_URL]`

Verify each URL in a signed-out browser. Do not submit repository paths or localhost
addresses.

## Physical-device recording

Prepare a short recording from a physical iPhone using the submitted configuration:

- Cold launch and initial data load
- Google or Apple sign-in
- Demonstration league and completed game
- Live scoring, undo and final score
- Player or box-score sharing
- **Report this information** and its confirmation reference
- Settings and the account-deletion control
- Any permission prompt the review build can display

Keep private credentials and unrelated personal notifications out of the recording.

## Final submission checklist

- [ ] Production iOS build installed and tested on a physical device
- [ ] Google and Apple sign-in verified in the production configuration
- [ ] Dedicated Google test account verified on a clean device without developer intervention
- [ ] Test account credentials supplied privately in App Store Connect's sign-in fields
- [ ] Sample league loads at launch and fictional demonstration data is verified
- [ ] Previously published unused codes invalidated; fresh unused codes supplied privately in Review Notes
- [ ] Production Supabase schema and authorization verified
- [ ] Content report submitted and reviewed end-to-end
- [ ] Account deletion completed with a disposable account
- [ ] Offline scoring and app-restart recovery verified
- [ ] Privacy declarations reconciled with the code and policy
- [ ] Support, Privacy, Terms and Content Policy HTTPS URLs verified
- [ ] App metadata and screenshots match the submitted build
- [ ] Physical-device recording prepared
- [ ] Regional availability statement confirmed
- [ ] Review Notes contain no placeholders

## Concise Review Notes template

Copy this into App Store Connect only after replacing every bracketed value:

> iTala is a basketball scorekeeping and statistics application. A sample league with
> pre-populated teams, players, games and statistics is available when the app opens.
> To test authenticated features, open the profile control and choose Sign in with Google.
> Use the dedicated Google test account supplied in the App Review Information sign-in
> fields; no personal account is needed. Then create a league with one of these single-use
> League Creation Codes: [LEAGUE_CREATION_CODE], [BACKUP_CODE_1], or [BACKUP_CODE_2].
> Only one code is required; the others are backups. Add or edit teams and players,
> create a scheduled or live game, select a starting lineup, record statistics, and
> finalize the game to view the box score, player statistics, standings and shareable
> stat cards. The app supports offline-first scorekeeping; changes are saved locally and
> synchronized when connectivity is available.
>
> To report content, open a player, team, league or box-score screen and scroll to
> Report this information. Select a reason and submit; explanation and contact email are
> optional. A successful submission displays a reference number for the private review queue.
>
> Account deletion is under Settings → Danger Zone → Delete Account. Deleting an account
> removes the authentication identity and iTala profile. Shared league, roster, game and
> statistical records are retained because other league members may rely on them.
> Privacy requests: https://itala.abejohanna.workers.dev/privacy/
>
> iTala has no subscription or in-app purchase, third-party advertising network or
> cross-app tracking. Sponsor cards record only an aggregate tap count. Notifications
> are local device notifications. The venue field is manual text and does not use device
> location. Photo-library access is optional for team logos or sponsor images; the app
> does not request camera, microphone, contacts or location permissions. There is no chat,
> direct messaging or social-media feed.
