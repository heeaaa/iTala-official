# Legal acknowledgement

The app opens Google or Apple first, then checks the authenticated account's receipt.
Only accounts without acceptance of the current version see an unchecked acknowledgement.
The user agrees to the Terms of Use and Content Policy and acknowledges the Privacy Policy.
The three documents have individual inline links; Settings keeps its separate link rows.
Declining signs out locally, explains that agreement is required for account use,
and returns to guest browsing. The account record is retained.

All sign-in entry points use `AdminProvider`. Account roles and memberships are
published only after the server confirms an acceptance receipt. If saving fails,
the user can retry or return to guest browsing. A restart after interrupted OAuth
checks the receipt rather than assuming that the persisted auth session means the
user accepted. Previously signed-in accounts without a receipt are asked once too.
Explicit sign-in and normal session restoration skip the prompt for a current receipt.
Only session restoration may fall back to a confirmed offline cache; explicit sign-in
requires a fresh server check. Closing the app with an unanswered prompt leaves the
session present, so reopening asks again. After declining and signing out, reopening
stays in guest mode; signing in to the unaccepted account asks again.

## Storage and scope

`legal_versions` describes each document bundle. The initial bundle is `2026-09-07`,
matching the documents' effective date. `legal_acceptances` stores `user_id`, bundle
`version`, and server-generated `accepted_at`. Repeating acceptance of a version is
idempotent and does not change the original date. Earlier version receipts remain.
Only the account itself can read its receipts through the API; direct client writes
are denied. `accept_legal` derives identity from the session, rejects anonymous users
and stale versions, and generates the timestamp. Account deletion cascades to receipts.
No IP address, device identifier, or extra provider profile data is collected.

A successful server receipt is cached per account for offline restoration. This is
an availability cache, not a backend authorization boundary. An observed version
mismatch invalidates it. An offline device cannot discover a newly required version
until an online restoration; active games are not interrupted by polling or write
checks. A user with no confirmed receipt needs connectivity to activate the account.

Existing league permissions and RLS remain authoritative and unchanged. This feature
adds no checks to scoring, reducers, sync dispatch, or individual create/update APIs.
Local-only development mode and the existing emergency admin mechanism are unchanged.

**OAuth boundary:** Supabase creates `auth.users` during OAuth/ID-token exchange,
before the receipt RPC can run. Anonymous spectators also already have auth identities.
Account creation may happen before agreement, including when the user later declines.
This feature prevents the shipped app from completing account entry without a receipt.
It is not a universal backend signup prohibition for modified/older clients or direct
Auth API calls. That stricter requirement would need a separate trusted pre-auth flow
and Supabase Auth hook.

## Deployment

1. Apply the legal acknowledgement section of `supabase/schema.sql` (or rerun the
   idempotent full schema) before shipping this client. No production changes are
   made by the feature implementation.
2. Verify the three public URLs and preserve the exact published HTML for this
   version in release records. The web reader could not retrieve these URLs during
   implementation; repository copies were inspected instead.
3. Review whether the Privacy Policy should explicitly describe account-linked legal
   receipts and their deletion with the account. If its text changes, assign a new
   bundle version before release so recorded versions identify the text actually shown.
4. Test Google and Apple on signed development builds, including failed receipt saves,
   cancellation, restart and offline restoration. Execute SQL tests against PostgreSQL.

## Changing the documents

Keep prior document snapshots and prior registry rows/receipts; do not overwrite
history or re-label changed text with the same version. Update `LEGAL_VERSION` and
the three links in `src/lib/legal.ts` for the new bundle. Publish the corresponding
documents and ship the matching app update. Then, in one database transaction, insert
the new registry row with `is_current = false`, set the old current row to false,
and set the new row to true. The partial unique index permits only one current row.

On the next account restoration or explicit sign-in, the matching new client asks
for acknowledgement. Older clients implementing this feature show an update-required
message instead of recording agreement to text they do not identify. Offline cached
sessions and already-active sessions continue until their next online restoration;
there is deliberately no per-action enforcement. Re-running the initial schema does
not reset the operator's current version.

### 2 October 2026 Connect privacy update

The new bundle is `2026-10-02`. Its Privacy Policy covers the app and Connect;
Terms of Use and Content Policy retain their 7 September text. Exact copies of
all three earlier pages and their stylesheet are in `site/archive/2026-09-07/`.
The app identifies the new bundle. The new migration
`supabase/migrations/20261003000100_stage_legal_connect_privacy.sql` updates the
old registry URLs to those archives and inserts the new row with `is_current =
false`. It preserves existing receipts and the current version. `schema.sql`
contains the same rows for fresh installations and does not activate a newer
version on an existing project.

The mobile project and Connect have separate Supabase databases. Run these SQL
steps against the **mobile iTala project only**. The PR targets `rel/build-three`;
merging it there does not publish the Cloudflare Worker, which deploys from
`main`. Other uncommitted work in either checkout must not be included in this
release by accident.

1. Publish only the September archive pages and stylesheet to the Cloudflare
   Worker first. Verify `/archive/2026-09-07/privacy/`, `/terms/` and
   `/content-policy/` from a signed-out browser, including their stylesheet and
   links. Keep the canonical policy unchanged at this point.
2. In the mobile repository, verify the Supabase CLI is linked to the **iTala
   mobile** project, run `npx supabase migration list`, then
   `npx supabase db push --dry-run`. Review every pending migration; do not push
   unrelated work. Push the staged legal migration with `npx supabase db push`.
   Check that the September row remains current, the October row is non-current,
   and existing `legal_acceptances` rows are still present:

   ```sql
   select version, is_current, terms_url, privacy_url, content_policy_url
     from public.legal_versions order by version;
   select version, count(*) from public.legal_acceptances
     group by version order by version;
   ```

3. Publish the revised canonical `/privacy/` page and the Connect footer link.
   Verify both live sites from a signed-out browser. Set the App Store Connect
   Privacy Policy URL to `https://www.itala.fyi/privacy/` and verify the page's
   effective date before publishing. Ship the matching iTala app build and check
   Profile → About → Privacy Policy on an iPhone and iPad as a guest. The new
   client expects `2026-10-02`, so coordinate app availability closely with
   the next step.
4. After the matching app build is available, create a **new, later-numbered
   migration** in `supabase/migrations/` containing the reviewed SQL from
   `supabase/release/promote_legal_2026_10_02.sql`. Verify the mobile project
   link and pending migrations again, then push it. That SQL checks both rows
   and switches `is_current` atomically; a missing staged row raises an error
   instead of leaving no current version. Do not run this template against the
   Connect database or place it in `migrations/` before the release gate.
5. Repeat the two queries above. Exactly one row must be current, and it must be
   `2026-10-02`; old acceptance counts must remain. `select public.legal_status();`
   must report `2026-10-02`. Test a previously accepted account: it should be
   asked to acknowledge the new bundle. Older app builds show an update-required
   message at their next online restoration.

Do not apply the entire `schema.sql` to production for this change. The staged
and promotion migrations are the tracked deployment path.

## App Store recommendation

One explicit checkbox is sufficient for this product flow; Apple's guidelines do
not prescribe three separate boxes. Guideline 5.1.1(i) requires an easily accessible
in-app privacy link and App Store Connect privacy URL. Acknowledgement of the Privacy
Policy is distinct from agreeing to contractual terms or granting optional permissions.
Keep optional permissions separate. Guideline 1.2's moderation requirements still
apply to user-generated content; a checkbox does not replace reporting or moderation.

Source: [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
(reviewed 7 September 2026).
