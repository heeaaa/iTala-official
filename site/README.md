# iTala public pages

Plain static HTML. No build step, no dependencies, no framework. Both stores require a publicly
reachable privacy policy URL, and keeping the policy in this repo means it sits next to the
declaration tables in `DEPLOYMENT.md` that it has to agree with. Those are what drift.

```
site/
  index.html          minimal landing page
  privacy/index.html  the privacy policy
  style.css           shared styles, light and dark
  _headers            Cloudflare Pages security headers
```

## Deploying to Cloudflare Pages

1. Cloudflare dashboard, Workers & Pages, Create, Pages, Connect to Git.
2. Pick the `heeaaa/iTala-official` repository.
3. Framework preset **None**. Build command **empty**. Output directory **`site`**.
4. Deploy. The policy is then at `https://<project>.pages.dev/privacy/`.
5. Paste that URL into both store listings. A custom domain can be attached later without changing
   the path.

## Operator and contact details

Filled in 29/08/2026. The policy names **Hanna Abejo Santos and Harold Abejo** as the joint agency
responsible, and gives **abejohanna@gmail.com** and **abejoharold@gmail.com** as the contact
addresses. The pre-publication notice has been removed.

Those addresses are load-bearing, not decorative: the app stores names and statistics of people who
never installed it, and this is the mechanism by which they can have that removed. They must stay
monitored. They are the same two addresses already on the `admin_emails` allowlist in
`supabase/schema.sql`.

CHECK 15 now fails the build if a `[OPERATOR]`/`[CONTACT EMAIL]` placeholder or the draft notice
reappears, so the policy cannot be published half-finished.

## Keeping it honest

The policy, the Apple nutrition labels and the Google Data safety form all describe the same
thing and must not disagree. If any of these change, change all three:

- what the app stores, in `src/` and `supabase/schema.sql`
- `site/privacy/index.html`
- the two tables in `DEPLOYMENT.md`, prerequisite gotcha #2

`tests/static.test.js` CHECK 15 asserts the policy still covers the topics the declarations depend
on, so deleting a section fails the build rather than going unnoticed.

Facts the policy asserts that are worth re-checking against the code if the schema changes:

- **Any signed-in session, including anonymous spectators, can read every roster.** That is the
  `read_all_*` policies in `supabase/schema.sql`, which are `using (auth.uid() is not null)`.
- **The venue is user-typed text, not device location.** There is no `expo-location` dependency and
  no location permission in `app.json`.
- **Notifications are local only.** `src/lib/notify.ts` uses `scheduleNotificationAsync` and never
  `getExpoPushTokenAsync`, so no push token is collected.
- **Promo taps are an aggregate counter.** `bump_promo_tap` runs
  `update promos set taps = taps + 1`, storing no user id.
- **Account deletion exists in the app.** `delete_own_account`, reached from Settings.
