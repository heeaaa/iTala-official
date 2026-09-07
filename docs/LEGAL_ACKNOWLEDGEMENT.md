# Legal acknowledgement

The app asks for one unchecked acknowledgement after a user taps Google or Apple,
before opening the provider. The user agrees to the Terms of Use and Content Policy
and acknowledges the Privacy Policy. The three documents have separate links.
Cancelling does not start OAuth. Settings also keeps the links available after sign-in.

All sign-in entry points use `AdminProvider`. Account roles and memberships are
published only after the server confirms an acceptance receipt. If saving fails,
the user can retry or return to guest browsing. A restart after interrupted OAuth
checks the receipt rather than assuming that the persisted auth session means the
user accepted. Previously signed-in accounts without a receipt are asked once too.
Because the provider account is not known until OAuth completes, an explicit sign-in
asks again even if that account already accepted; the server preserves its original
receipt date. Normal session restoration does not ask again for an accepted version.

## Storage and scope

`legal_versions` describes each document bundle. The initial bundle is `2026-09-04`,
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
This feature prevents the shipped app from starting account creation without agreement
and from completing account entry without a receipt. It is not a universal backend
signup prohibition for modified/older clients or direct Auth API calls. That stricter
requirement would need a separate trusted pre-auth flow and Supabase Auth hook.

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

## App Store recommendation

One explicit checkbox is sufficient for this product flow; Apple's guidelines do
not prescribe three separate boxes. Guideline 5.1.1(i) requires an easily accessible
in-app privacy link and App Store Connect privacy URL. Acknowledgement of the Privacy
Policy is distinct from agreeing to contractual terms or granting optional permissions.
Keep optional permissions separate. Guideline 1.2's moderation requirements still
apply to user-generated content; a checkbox does not replace reporting or moderation.

Source: [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
(reviewed 7 September 2026).
