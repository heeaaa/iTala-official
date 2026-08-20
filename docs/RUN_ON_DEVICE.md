# Getting it onto an iPhone

Written for a Windows machine with no Mac, which means iOS builds happen on
EAS rather than locally. You have the Apple Developer membership already, so
everything below is free apart from time.

Total: about 30 minutes, most of it waiting on one cloud build.

---

## 1. Tooling on your PC (once)

```powershell
node --version        # need 22 or newer
npm install -g pnpm eas-cli
```

Then, in the repo:

```powershell
cd "C:\Users\aeron.santos\Downloads\HEAS files\iTala-official"
pnpm install
pnpm verify
```

`pnpm verify` should end with 102 and 18 tests passing. If that works, the code
is sound and anything that goes wrong from here is environment, not logic.

## 2. Point the app at your database (once)

Create the file `apps\mobile\.env` with two lines:

```
EXPO_PUBLIC_SUPABASE_URL=https://ugoqwziiuxjlshupqzhh.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<your anon key>
```

**It must be in `apps\mobile`, not the repository root.** Expo reads `.env`
from the directory you run the bundler in. `apps\mobile\.env.example` is the
template, and `.env` is gitignored.

Get the anon key from Supabase, Settings, API. Do not use the service_role key
for this or anything else.

If you skip this step the app still runs, but entirely local-only: no sync, no
second device, and the Phase 1 test is untestable. The league settings screen
tells you which mode you are in.

## 3. Log in to EAS and link the project (once)

```powershell
eas login
eas init --id bf4508b7-20f9-4342-a315-9b6f6121aef9
```

The id is the EAS project you already have, and it is already in `app.json`, so
`eas init` should just confirm the link rather than create anything.

## 4. Register the iPhone (once per device)

```powershell
eas device:create
```

Choose **Website**, and it prints a URL and a QR code. Open that on the iPhone
in **Safari** (not Chrome), install the profile it offers, then go to Settings,
General, VPN and Device Management and tap through to install it.

This registers the phone's identifier with Apple so a build can be signed for
it. It is required for any iOS build that is not going through TestFlight.

## 5. Build the development client (about 15-25 minutes)

```powershell
pnpm --filter @itala/mobile build:dev:ios
```

EAS will ask to generate a distribution certificate and provisioning profile.
Say yes to both; it stores them for you and you will not be asked again.

When it finishes it prints a URL with a QR code. Open that on the iPhone and
install. You now have an app called iTala on your home screen.

**What this build is.** A development client: your app's native shell, with the
JavaScript loaded from your PC over Wi-Fi. It behaves the way Expo Go used to,
and it is why you only rebuild when a native dependency changes, not when code
changes. Expo Go itself is not an option on SDK 56, which is no longer
published to the App Store.

## 6. Run it

Phone and PC on the same Wi-Fi, then:

```powershell
pnpm --filter @itala/mobile start
```

Open iTala on the phone. It should connect and load. From here, every code
change reloads in a second or two with no rebuild.

**If it hangs on "Opening project":** that is almost always Windows Firewall or
a guest network isolating devices. Use a tunnel instead, which routes through
Expo's servers and works regardless:

```powershell
pnpm --filter @itala/mobile start:tunnel
```

## 7. Test it

Work through `docs/VERIFY.md`. The Phase 2 section runs entirely on one phone.

### Doing the Phase 1 test with only one device

The offline test is written for two devices. With one iPhone you can still
prove the important half, because the failure modes are about the device and
the server disagreeing, not about two devices disagreeing:

1. Unlock admin, create a league, two teams, a few players, start a game.
   Wait for the banner to disappear, which means everything reached the server.
2. **Turn on Aeroplane Mode.**
3. Log 20 stats. The score updates on every tap. The banner reads
   "20 changes not synced, waiting for a connection."
4. **Force-quit the app entirely** (swipe up and away) and reopen it. All 20
   stats are still there and the banner still says 20 not synced. This is the
   one that matters most: nothing is ever applied locally without the intent to
   send it being written in the same transaction.
5. Turn Wi-Fi back on. Within a few seconds the banner disappears.
6. Tell me, and I will read the server from here and confirm the event count is
   exactly right with nothing lost and nothing duplicated. I can do that with
   the anon key, which is read-only for me since I am not admin.
7. Log one more stat, wait for the banner to clear, then tap Undo. Tell me
   again and I will confirm the event is gone from the server and has not come
   back. That is v1's worst bug and the one Phase 1 exists to fix.
8. To test the "a fresh device sees everything" case: delete the app from the
   phone and reinstall from the same EAS link. Local storage starts empty, and
   the app should pull the whole league back down.

### If you can get hold of the Poco X5 Pro

Android is much easier for a second device: no provisioning, no profile, just
an APK.

```powershell
pnpm --filter @itala/mobile build:dev:android
```

Install the APK it gives you, point it at the same dev server, and you can run
the real two-device test: both online, one goes offline, both log stats,
reconnect, and check that the server ends up with the sum of both.

## What you cannot test yet, and why

- **The iPad landscape tracker** needs the iPad. On an iPhone 17 the shorter
  side is under the 700pt breakpoint, so you will always get the phone layout:
  one team at a time, tap the other side of the scoreboard to switch. That is
  correct behaviour, not a bug.
- **Standings, leaders, the play-by-play and sharing** are Phases 3 to 5 and do
  not exist yet.

## Things that go wrong, and what they mean

| Symptom                                                  | Cause                                                     | Fix                                                          |
| -------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| Settings says "Local-only"                               | `.env` missing, in the wrong folder, or misspelt variable | It must be `apps\mobile\.env` with both `EXPO_PUBLIC_` names |
| "Could not reach the server" on unlock                   | Anonymous sign-in disabled, or no network                 | Supabase, Authentication, Providers, Anonymous               |
| "No admin password has been set"                         | The bcrypt snippet was never run                          | See `supabase/README.md`                                     |
| Wrong password five times, then even the right one fails | Working as designed: a 15 minute lockout                  | Wait it out, or clear the row in `admin_attempts`            |
| Bundler hangs on "Opening project"                       | Firewall or guest Wi-Fi                                   | `start:tunnel`                                               |
| Red banner: "changes could not be saved"                 | The device is not admin, so RLS is refusing               | Unlock admin. This banner is the Phase 1 fix working         |
| Build fails on signing                                   | Certificate or profile trouble                            | `eas credentials` and let EAS regenerate                     |
