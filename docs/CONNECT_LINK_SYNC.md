# Connect link status and schedule cache

Implemented on 1 October 2026. Local evidence is recorded in
[`../tests/CONNECT-LINK-VERIFICATION.md`](../tests/CONNECT-LINK-VERIFICATION.md).
The hosted rollout and native device walkthrough have not been performed.

## App behavior

The mobile league has server-owned `connect_events`, `connect_link_revision`
and `connect_link_checked_at`. Normal league sync and the existing league
realtime subscription carry them to devices. Local persistence retains them
across app restarts.

| Status | Start Game / Tip Off / Default |
| --- | --- |
| Not checked yet | Ordinary games available; no Connect request. |
| Checked; no published linked events | Ordinary games available; no Connect request. |
| Published linked events | Choose a game on Schedule; no discovery from game screens. |
| Drop-in or local-only app | Existing ordinary-game behavior. |

Schedule and the owner's league settings can discover links. Concurrent checks
share a request. Ordinary visits throttle successful and failed discovery for
five minutes; explicit Refresh retries immediately. Spectator Refresh reads the
mobile registry. Schedule content has a separate five-minute memory/disk cache:
fresh tab visits reuse it; manual and foreground refresh update it.

Failed checks retain the previous status. Unknown/unlinked leagues show a quiet
message and can still start games. A known event can serve its schedule when
discovery fails. Failed schedule refresh preserves cached games. Newer link
revisions invalidate the event cache; unlinking removes old games. Older
snapshots cannot overwrite newer metadata. During backend upgrades the legacy
lookup supplies a revision-zero hint, which cannot replace authoritative metadata.

## Cross-project delivery

Connect records changes in a transactional database queue. Linking, publishing,
unpublishing, renaming, relinking and cascading deletion all queue a snapshot.
The Netlify worker polls every five minutes and handles up to ten leagues per
run. Backlog and outages can delay delivery. Failures stay pending; an
exact-revision acknowledgement cannot clear a newer update.

Connect sends metadata to the mobile `connect-link-state` Edge Function using
a dedicated shared secret. The receiver validates it and calls the mobile
service-only `apply_connect_link_snapshot` RPC. Connect holds no mobile database
service key. Clients cannot forge league status. Stale revisions are ignored
and receiver request size is bounded.

Once the mobile registry records a published schedule, the database rejects
new freeform games. Existing games can keep syncing. Scheduled starts/defaults
receive a server authorization for the exact league and teams after current
schedule validation; a `cg_` ID alone is insufficient. Refused stale/offline
starts retain the local game and pending write, with guidance to use Schedule.

## Coordinated rollout

Apply database changes before enabling the worker or releasing the mobile app.
No database reset is required.

1. **Mobile database:** ensure existing schedule/default-game migrations are
   applied, then apply `supabase/migrations/20261001000200_connect_link_state.sql`.
   The same addition is in the repeatable `supabase/schema.sql`.
2. **Connect database:** apply its existing migrations, then
   `20261001000100_mobile_link_sync.sql`. Existing links are queued automatically.
3. Set the same new random `CONNECT_LINK_SYNC_SECRET` (at least 32 characters)
   in mobile Edge Function secrets and Connect's Netlify **Functions** environment.
   Keep the value out of source control, command logs and client environment.
   Retain the bridge's existing `CONNECT_SUPABASE_URL` and
   `CONNECT_SUPABASE_SERVICE_ROLE_KEY` configuration.
4. Deploy the mobile functions:

   ```sh
   supabase functions deploy connect-link-state --project-ref YOUR_MOBILE_REF --no-verify-jwt
   supabase functions deploy connect-schedule --project-ref YOUR_MOBILE_REF
   ```

   Only `connect-link-state` disables gateway JWT verification; it checks its
   dedicated secret. `connect-schedule` keeps caller JWT verification. The
   mobile platform supplies its own `SUPABASE_SERVICE_ROLE_KEY` to functions.
5. Publish the Connect branch to Netlify. Functions must receive
   `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `MOBILE_SUPABASE_URL` and
   `CONNECT_LINK_SYNC_SECRET`. Confirm `sync-mobile-links` is registered as scheduled.
6. Observe backfill delivery and both devices receiving status through normal
   league sync, then release/test mobile. Owner Schedule/Settings Refresh can
   discover and persist status immediately.

Reference: [Netlify scheduled functions](https://docs.netlify.com/build/functions/scheduled-functions/)
and [Supabase function configuration](https://supabase.com/docs/guides/functions/function-configuration).

## Hosted/device acceptance checks

Use isolated test leagues/events after deployment. Record actual results.

1. Repeat Start Game, Tip Off and Default/Forfeit on an unlinked league with
   Connect unavailable: no blocking modal or discovery request.
2. Link a draft event: regular mode stays available. Publish it and confirm
   worker delivery plus both devices switching to scheduled mode.
3. Refresh owner Schedule/Settings: the linked event appears immediately.
   Revisit Schedule within five minutes without Refresh and confirm cache reuse.
4. Pause receiver delivery, change a link, then resume. The pending queue must
   deliver the latest status. Older delivery/ack must not revert/erase it.
5. Unpublish, relink, unlink and delete test events; both devices follow the
   latest revision. Final unlink restores ordinary games.
6. Retry scheduled start/default: same deterministic ID. Existing ordinary
   games must still accept stats/status updates after linking.
7. Run the native UI cases in `tests/MANUAL-REGRESSION.md` on compact phones,
   iPhone 17 and iPad with larger text, rotation and Split View.
