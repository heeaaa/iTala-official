# Troubleshooting

Development-time failures and what actually causes them. Each section leads with
the symptom, because that is what you have when you arrive here.

- [Expo Go hangs on "Opening the project"](#expo-go-hangs-on-opening-the-project)
- [Google sign-in: "Safari cannot open the page because the address is invalid"](#google-sign-in-safari-cannot-open-the-page-because-the-address-is-invalid)
- [Apple sign-in fails, or is rejected](#apple-sign-in-fails-or-is-rejected)
- [Everything times out and the logs say "Network request failed"](#everything-times-out-and-the-logs-say-network-request-failed)
- [The score jumped, reverted, or double-counted](#the-score-jumped-reverted-or-double-counted)

---

## Expo Go hangs on "Opening the project"

If `npx expo start` shows the QR code but Expo Go on your phone gets stuck on
**"Opening the project…"** and times out, the cause is almost always **networking**:
Expo Go downloads the manifest but can't reach the JS bundle because Metro advertised a
`127.0.0.1` / `localhost` address (which on the phone means the phone itself), or your
PC and phone can't reach each other over the LAN (different Wi-Fi, VPN, or firewall).

The app code is fine — this is about how the dev server is reached. Try these in order.

## 1. Tunnel mode (most reliable — fixes it ~90% of the time)
Works even if the phone and PC are on different networks or a VPN/firewall is in the way.

```bash
npm run start:tunnel
# (equivalent to: npx expo start --tunnel -c)
```

The first run asks to install `@expo/ngrok` — accept it. Then scan the QR again.

## 2. Same Wi-Fi + clear cache
Make sure the **phone and computer are on the exact same Wi-Fi network** (not "Guest",
and phone not on cellular). Then:

```bash
npm run start:clear
# (npx expo start -c  — clears a stale Metro cache from earlier attempts)
```

## 3. Force your computer's LAN IP
If LAN mode connects to the wrong address, tell Metro your real IPv4.

1. Find your IPv4 address:
   - **Windows:** run `ipconfig`, look for `IPv4 Address` (e.g. `192.168.1.42`)
   - **macOS:** `ipconfig getifaddr en0`
2. Start with that host:

   **Windows (PowerShell):**
   ```powershell
   $env:REACT_NATIVE_PACKAGER_HOSTNAME="192.168.1.42"
   npx expo start --lan -c
   ```
   **Windows (cmd):**
   ```cmd
   set REACT_NATIVE_PACKAGER_HOSTNAME=192.168.1.42
   npx expo start --lan -c
   ```
   **macOS/Linux:**
   ```bash
   REACT_NATIVE_PACKAGER_HOSTNAME=192.168.1.42 npx expo start --lan -c
   ```

## 4. Firewall (Windows)
Windows Defender often blocks Node's LAN access on first run. When the prompt appears,
allow **Node.js** on **Private networks**. If you dismissed it earlier, allow it under
Windows Security → Firewall → Allow an app, or just use tunnel mode (#1).

## Other checks
- Confirm Expo Go is the **SDK 54** build (latest from the App Store / Play Store).
- This project runs with the **New Architecture enabled**. `app.json` does not set
  `newArchEnabled` at all, and Expo SDK 54 defaults it to `true` when omitted. Verify for
  yourself with `npx expo config --type introspect`, which reports `RCTNewArchEnabled: true`.
  This doc previously claimed the opposite, which is worth knowing: if you are chasing a hang
  or a native crash, the New Architecture is a live suspect, not one you can rule out. To turn
  it off you have to set `"newArchEnabled": false` explicitly, and that is a real runtime
  change worth testing on a device rather than a documentation tweak.
- A red error screen on the phone is *progress*, not the hang — send the error text.

## Sanity check the server is healthy
With `npx expo start` running, from the **same computer**:
```bash
curl -s -H "expo-platform: ios" http://localhost:8081 | findstr launchAsset   # Windows
curl -s -H "expo-platform: ios" http://localhost:8081 | grep launchAsset      # mac/Linux
```
If the `launchAsset` URL says `127.0.0.1` or `localhost`, that's exactly why the phone
can't load it — use tunnel mode (#1) or force the LAN IP (#3).

---

## Google sign-in: "Safari cannot open the page because the address is invalid"

**Cause: the redirect URL is not on the Supabase allowlist.** Nothing is wrong
with the Google provider, and checking it is a dead end.

Supabase honours `redirect_to` only when it is on the project's allowlist and
**silently falls back to the Site URL** otherwise. The Site URL is
`itala://auth-callback` - a scheme only a real build registers. So in Expo Go the
flow ends by handing Safari a URL no installed app claims, and Safari says the
address is invalid. It reads like a broken app; it is a missing line in a
dashboard.

You can confirm it in one command, without touching the app:

```bash
curl -s -o /dev/null -D- -H "apikey: $ANON_KEY" \
  "$SUPABASE_URL/auth/v1/verify?type=signup&token=x&redirect_to=<url-encoded redirect>" \
  | grep -i '^location'
```

If the `Location` comes back as the Site URL rather than the redirect you asked
for, that redirect is not allowlisted. (A deliberately bogus URL returns the same
thing, which is how you tell.)

**Fix:** Supabase → Authentication → URL Configuration → Redirect URLs, and add
the URL the app prints at startup:

```
[auth] OAuth redirect URL (add to Supabase → Auth → URL Configuration): exp://192.168.68.104:8081/--/auth-callback
```

In Expo Go that URL contains your machine's LAN IP and changes when the network
does, so `exp://*` is the practical entry.

**Or just build.** A development, preview or production build redirects to
`itala://auth-callback`, which *is* the Site URL and is therefore always
accepted - no allowlist entry needed at all.

## Apple sign-in fails, or is rejected

Apple signs the identity token for the bundle id of the app that asked. Inside
Expo Go that is Expo Go's own (`host.exp.Exponent`), never `com.bpbl.itala`, and
Supabase checks the token audience against the provider's Client IDs. So it is
rejected unless `host.exp.Exponent` is in that list.

See AUTH_SETUP.md step 1 - and **remove that entry before shipping**; it is on
the DEPLOYMENT.md pre-flight checklist. A build needs no workaround.

## Everything times out and the logs say "Network request failed"

```
WARN  [auth] getSession timed out after 5000ms
WARN  [sync] INSERT_events rejected: TypeError: Network request failed
```

This is the device failing to reach Supabase, not a bug in the auth or sync code.
`getSession()` resolves only after supabase-js finishes initialising, and that
initialisation refreshes an expired token **over the network** - so one
unreachable host makes every later call look like it hung.

Check, in order:

1. **Is the project up?** `curl -s "$SUPABASE_URL/auth/v1/health" -H "apikey: $ANON_KEY"`
   should return the GoTrue version. A free project auto-pauses after 7 idle
   days (the keep-alive workflow exists to prevent this - see DEPLOYMENT.md).
2. **Can the phone reach the internet at all**, not just your dev machine? A
   captive-portal wifi that has not been signed into will load the Metro bundle
   over the LAN and fail every outbound HTTPS request.
3. **A VPN or content blocker on the phone.**

The app no longer treats a timed-out session probe as "signed out" - that used to
purge the stored tokens and mint a new anonymous user, quietly signing people out
and reassigning their drop-in games. If you are testing that path, expect the app
to keep the session and simply report that it could not reach the server.

## The score jumped, reverted, or double-counted

Symptoms: a stat appears and vanishes a few seconds later; the next tap adds
double; undo and redo do not land where you expect.

This class of bug is fixed - see `src/sync/pendingEvents.ts` and the S9-S17 cases
in `tests/sync.test.js`, which reproduce it against a latency-modelling server
emulator. If something like it recurs:

- **Does it survive `npm test`?** The suite models exactly this: a snapshot read
  before a write lands and applied after it. A reproduction that the emulator can
  express belongs there first.
- **Is the write actually reaching the server?** The sync badge goes red on a
  failed push, and a failed write is deliberately *pinned* locally rather than
  reverted - so a stat that stays on screen with a red badge is working as
  intended, not stuck.
- **Suspect anything that dispatches HYDRATE without a `snapshotAt` tick.** That
  is the one way to skip reconciliation and clobber pending writes; CHECK 9 in
  `tests/static.test.js` fails the build if a call site loses it.
