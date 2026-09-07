# iTala public pages

Plain static HTML. No build step, no dependencies, no framework. Both stores require a publicly
reachable privacy policy URL, and keeping the policy in this repo means it sits next to the
declaration tables in `docs/DEPLOYMENT.md` that it has to agree with. Those are what drift.

```
site/
  index.html          minimal landing page
  privacy/index.html  the privacy policy
  terms/index.html    terms of use
  content-policy/     content and moderation policy
  support/index.html  support contacts and help route
  style.css           shared styles, light and dark
  _headers            security headers, applied by Cloudflare to every response
  .assetsignore       files here that are repo documentation, not published pages
```

## Deploying

The pages are published by the Cloudflare **Worker** named `itala`, connected to
this repository, on every push. There is no build step - the Worker serves
`site/` as static assets.

They are served from **`https://www.itala.fyi/`**, which is what the app, the
legal receipts and both store listings point at:

| Page | URL |
| --- | --- |
| Landing | `https://www.itala.fyi/` |
| Terms of Use | `https://www.itala.fyi/terms/` |
| Privacy Policy | `https://www.itala.fyi/privacy/` |
| Content Policy | `https://www.itala.fyi/content-policy/` |
| Support | `https://www.itala.fyi/support/` |

The custom domain is attached in the Cloudflare dashboard (Worker `itala` →
Settings → Domains & Routes), not in `wrangler.jsonc`, so it does not appear in
a diff. Two things to know about that:

- The Worker's own `*.workers.dev` address keeps answering after the domain is
  attached. An old link therefore keeps working instead of 404ing, which is why
  a stale store listing or legal receipt fails silently. `tests/static.test.js`
  fails the build if any published surface still names the retired host.
- Add **both** `itala.fyi` and `www.itala.fyi`, or pick one and redirect the
  other. The URLs above use `www`, so a visitor typing the apex must land
  somewhere rather than nowhere.

The configuration is [`../wrangler.jsonc`](../wrangler.jsonc), in the repo rather
than only in the dashboard. It has to be: Cloudflare's deploy command
(`npx wrangler versions upload`) cannot know what to upload without it, and every
branch build failed with

```
✘ [ERROR] Missing entry-point to Worker script or to assets directory
```

until it was checked in. Keeping it here also means a change to how the site
deploys shows up in a diff.

To verify a change before pushing:

```bash
npx wrangler@4 deploy --dry-run     # should read the assets directory, not error
```

Paste the deployed `/privacy/`, `/terms/`, `/content-policy/` and `/support/` URLs into the
relevant store-listing fields and review notes. A custom domain can be attached later without
changing the paths.

`site/README.md` itself is excluded from the upload by `.assetsignore` - without
that it would be served at `/README.md`.

## Operator and contact details

Filled in 29/08/2026. The policy names **Hanna Abejo Santos and Harold Abejo** as the joint agency
responsible, and gives **hanna@itala.fyi** and **harold@itala.fyi** as the contact
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
- the two tables in `docs/DEPLOYMENT.md`, prerequisite gotcha #2

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
