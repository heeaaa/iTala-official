# iTala architecture

This document describes the major runtime boundaries and design decisions behind
iTala. It is intentionally implementation-focused; the root README remains a concise
product and contributor introduction.

## Application structure

`App.tsx` loads the fonts, providers and native-stack navigation. The 20 registered
screens cover league setup, roster management, live scoring, results, profiles,
sharing, administration, settings and content reporting.

The source is organized around four responsibilities:

- `src/screens/` contains route-level interfaces.
- `src/components/` contains shared controls, score displays and card renderers.
- `src/store/` owns local state, persistence, authorization context and reducer
  dispatch.
- `src/sync/` translates local actions into Supabase operations and reconciles remote
  state.
- `src/lib/` contains stat derivation, parsing, formatting, notifications, sharing
  specifications and other pure or narrowly scoped behavior.

## State and derived statistics

The reducer in `src/store/StoreProvider.tsx` is the client-side state authority. User
actions update the reducer, and `src/store/storage.ts` persists the resulting state to
AsyncStorage.

Box scores, standings, leaders, career totals and season awards are derived from the
event log rather than stored as independent source-of-truth totals. Editing or deleting
an event therefore recalculates every dependent view through the functions in
`src/lib/stats.ts`.

Identifiers used by a dispatch are stamped before the reducer runs. This keeps the
state mirrored to Supabase consistent with the state rendered by React, even when the
same reducer action is evaluated more than once.

## Local-only mode

When either required `EXPO_PUBLIC_SUPABASE_*` value is absent, `SYNC_ENABLED` is false. The
application loads and saves its state locally and does not initialize Supabase-backed
accounts or synchronization.

This is a separate development configuration, not a fallback entered when a synced
build loses connectivity. Data remains on one device with no later server replay.
Local league-administration controls require the local admin password configuration
and unlock. This mode does not provide shared leagues, invitations, remote spectators
or the server-backed content-report queue.

## Synced mode

The supported user workflow requires connectivity for sign-in, league creation and
creation-code validation, roster administration, and drop-in/recreational game setup.
Prepare and start the game online; live scoring can then tolerate a connection loss.

When Supabase configuration is present, the local reducer remains the immediate UI
state. Sync-eligible actions update locally first and are then mirrored to Supabase;
some device-only actions intentionally remain local. Realtime notifications trigger a
fresh server read so other devices converge on the same league state.

The sync layer includes two protections for active games:

1. `src/sync/pushQueue.ts` serializes outgoing writes so a rapid sequence of scoring
   actions cannot arrive out of order.
2. `src/sync/pendingEvents.ts` records event and game changes the server has not yet
   confirmed. A server snapshot is reconciled with these pending writes rather than
   being allowed to erase newer local work.

Event ordering uses `(timestamp, id)` rather than timestamp alone. Two scoring actions
can occur in the same millisecond, and undo must identify the same final event on every
device.

Some compound operations, including recreational-game setup and bulk roster import,
are submitted through database RPCs so their related rows succeed or fail together.

### Conflict behavior

Two scorekeepers should not edit the same game at the same time. General record updates
use a last-write-wins model. Append-only stat events have client-generated identifiers,
so separate games and distinct event writes do not share an identity.

Active-game event and game writes receive the pending-write reconciliation described
above. Administrative mutations such as roster and league changes do not all have an
equivalent durable offline replay path. The manual regression plan must therefore cover
offline roster and league administration separately; the product's strongest offline
guarantee is for active-game scoring.

In particular, `CreateLeagueScreen` dispatches `ADD_LEAGUE` and navigates before the
`create_league` RPC confirms success. That RPC validates and consumes the code, creates
the league, and grants owner membership. Validating a code earlier does not complete
those operations. A failed creation can therefore leave a local league visible without
server ownership, blocking roster administration; a later server snapshot can remove
the unsaved league. This is an existing failure-handling limitation, not an offline
setup capability. The interface should eventually wait for server confirmation or
clearly report and recover from failure.

## Authentication and authorization

Synced mode uses Supabase Auth:

- A guest receives an anonymous session and can access spectator data allowed by RLS.
- Google and Apple sign-in create named users.
- League membership assigns owner and scorekeeper permissions.
- A platform administrator has additional application-wide privileges.

The client hides or shows controls based on the role exposed by
`src/store/AdminProvider.tsx`, but Supabase row-level security and RPC validation remain
the enforcement boundary for synchronized data. Client checks are interface guidance,
not the security boundary.

An emergency password-elevation flow exists for administration. Its secret is stored as
a server-side bcrypt hash, attempts are throttled, and no usable password belongs in the
repository or an `EXPO_PUBLIC_*` variable. Operational setup is documented in
[Authentication setup](AUTH_SETUP.md).

## Public and private data

League, team, player, game and event records are readable by valid app sessions,
including anonymous spectator sessions. This supports public score and roster viewing
inside the app and is disclosed in the Privacy Policy and Terms.

Content reports use a separate table with RLS. Clients submit reports through the
`submit_content_report` security-definer RPC; report contents and contact emails are not
part of the public read model. Administrators can review the queue and maintain its
status and resolution fields.

## Sharing and device services

Achievement cards are rendered from `CardSpec` data and captured with
`react-native-view-shot`. `expo-sharing` opens the platform share sheet when available;
text sharing is the fallback.

Team and sponsor images come from the user's photo library through
`expo-image-picker`. Camera and microphone permissions are disabled because the app does
not record either. Notifications are scheduled locally; the app does not request an Expo
push token.

## Testing boundaries

`npm test` exercises reducer and statistics behavior, synchronization against a
PostgREST emulator, provider behavior, repository invariants and SQL routines. CI runs
the database suites against PostgreSQL and separately verifies lint and Metro bundling.

Automated tests do not render the native application or prove real platform behavior.
Gestures, share-sheet capture, permissions, screen readers, upgrades and live Supabase
RLS behavior remain part of the [manual regression checklist](../tests/MANUAL-REGRESSION.md).
