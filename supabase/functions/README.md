# Supabase Edge Functions

One function lives here: **`delete-account`**.

## Why it exists

`public.delete_own_account()` in `supabase/schema.sql` deletes `auth.users`, and
the app then clears its local session. For a Google account that is the whole
job. For an account created with **Sign in with Apple** it is not: Apple is
never told anything, so iTala stays listed under *Settings → your name →
Sign-In & Security → Sign in with Apple* with a live authorisation. App Review
guideline 5.1.1(v) requires an app that offers Sign in with Apple **and**
account deletion to call Apple's REST revoke endpoint as part of that deletion.

That call needs a client secret which is a JWT signed **ES256** with the team's
Sign in with Apple private key. The key cannot go in the app bundle (every
`EXPO_PUBLIC_*` value is inlined into the shipped JavaScript, and a key in git
history cannot be un-published) and it cannot go in Postgres (no ES256, no
outbound HTTP). So the revocation happens here.

## What it does, in order

```text
POST /functions/v1/delete-account
Authorization: Bearer <the caller's own access token>
{ "appleAuthorizationCode": "<fresh, single-use code from the Apple sheet>" }

  1. verify the caller by asking GoTrue (/auth/v1/user), refuse anonymous sessions
  2. refuse an account with no Apple identity  -> 409 no_apple_identity
                                                  (the client then uses the RPC)
  3. read the Apple `sub` THIS ACCOUNT is linked to from the GoTrue identity
     -> 502 apple_identity_unreadable if there isn't one
  4. exchange the authorization code at https://appleid.apple.com/auth/token
  5. check the returned id_token's `sub` against step 3
     -> 409 apple_account_mismatch, revoking nothing
  6. revoke the refresh token at https://appleid.apple.com/auth/revoke
  7. ONLY THEN call delete_own_account, as the caller
  -> 200 { "revoked": true, "deleted": true, "tokenType": "refresh_token" }
```

Three properties are load-bearing:

- **Revoke before delete, and fail closed.** Once `auth.users` is gone the app
  can prove nothing to Apple, so a deletion that ran first would leave exactly
  the dangling authorisation this function removes. A failed revocation deletes
  nothing and the client offers a retry.
- **The revocation is bound to the account, not to the device.**
  `AppleAuthentication.signInAsync` always authenticates whichever Apple ID is
  signed in to the *device*, while the Supabase session lives in AsyncStorage
  and survives an iCloud switch, a restored backup or a handed-down phone. So
  step 5 exists: without it, deleting on a device now signed in as a different
  Apple ID would revoke *that* person's grant (minting one first if they had
  none), delete the account, and leave the account's own authorisation live -
  the original failure, with a green tick on top.
- **No service-role key.** The function calls `delete_own_account` with the
  caller's own bearer token, so `auth.uid()` inside the database is still what
  authorises the delete. A forged request cannot delete somebody else's account
  because it cannot present their access token.

The `id_token` in step 5 is read without verifying its signature. That is what
OpenID Connect permits for a token collected straight from the token endpoint:
it arrived in the HTTPS response to a request authenticated with our own ES256
client secret, so TLS plus that secret already establish where it came from.
Fetching Apple's JWKS from inside an edge function to re-verify it would add a
network dependency and a key-rotation failure mode without adding a guarantee.

**What this does not guarantee.** `delete_own_account` is still granted to
`authenticated`, so the ordering is enforced by the app, not the database. Any
holder of a user access token - including an older installed build during a
staged rollout - can call the RPC directly and delete an Apple-linked account
with no revocation. Fixing that would mean giving this function a service-role
key (it has none on purpose) or gating the RPC in a way older clients fail on.
The accurate claim is "the app revokes before deleting".

The code is single-use and expires in minutes, which is why the app re-confirms
with Apple at deletion time instead of storing a refresh token from sign-in. The
alternative - exchanging at sign-in and keeping the refresh token server side -
means holding a long-lived credential for somebody's Apple ID for the life of
the account, to use once, if ever. Nothing Apple-related is persisted anywhere.

## Secrets

Four, set as function secrets. None of them belongs in the repo.

| Secret | Where it comes from |
| --- | --- |
| `APPLE_TEAM_ID` | Apple Developer → Membership → Team ID (10 characters) |
| `APPLE_CLIENT_ID` | **The app's bundle id**, `com.bpbl.itala` - not a Services ID |
| `APPLE_KEY_ID` | Certificates, Identifiers & Profiles → Keys → the Sign in with Apple key |
| `APPLE_PRIVATE_KEY` | Contents of that key's `.p8` download (PKCS#8 PEM) |

`APPLE_CLIENT_ID` is the detail that costs an afternoon if it is wrong. Apple
signs a native credential for whichever app asked for it, so the audience of a
code from `expo-apple-authentication` is the bundle id. A Services ID here fails
the exchange with `invalid_client`. In Expo Go the audience is
`host.exp.Exponent` instead, which is not revocable with these secrets - **test
revocation on a development or TestFlight build, not in Expo Go.**

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are injected by the platform; do not set
them.

### Where the Apple key comes from

This is a **different Apple credential from the provider setup** in
`docs/AUTH_SETUP.md`. Native Sign in with Apple needs no key; revocation does.

1. developer.apple.com → *Certificates, Identifiers & Profiles* → **Keys** → **+**
2. Name it (e.g. "iTala Sign in with Apple"), tick **Sign in with Apple**, press
   **Configure**, choose the primary App ID `com.bpbl.itala`, **Save**
3. **Continue → Register → Download.** You get `AuthKey_ABCDE12345.p8`, and the
   10 characters in that filename are your `APPLE_KEY_ID`.
4. **Apple lets you download it once.** Put it in a password manager. Never in
   this repository.

`APPLE_TEAM_ID` is on developer.apple.com under *Membership details*.

### Setting them

The .p8 is multi-line, which is the only awkward part. Flattening it to one
line with literal `\n` avoids every quoting question, and
`readAppleClientConfig` restores the newlines - that is what the `\\n` handling
in it is for. Run this from Git Bash, with the real project ref:

```bash
REF=YOUR_SUPABASE_PROJECT                         # your project ref like dsoogiyf...
P8="$HOME/Downloads/AuthKey_ABCDE12345.p8"        # where you saved the key
SECRETS="$HOME/itala-apple-secrets.env"           # OUTSIDE the repo, deleted below

{
  echo "APPLE_TEAM_ID=XXXXXXXXXX"
  echo "APPLE_CLIENT_ID=com.bpbl.itala"
  echo "APPLE_KEY_ID=ABCDE12345"
  printf 'APPLE_PRIVATE_KEY='; awk '{printf "%s\\n", $0}' "$P8"; echo
} > "$SECRETS"

npx supabase@latest secrets set --env-file "$SECRETS" --project-ref "$REF"
rm "$SECRETS"

npx supabase@latest secrets list --project-ref "$REF"   # names only, no values
```

The dashboard works too (*Project Settings → Edge Functions → Secrets*); paste
the same one-line `\n` form of the key there.

## Deploy

**Run it from the repository root.** The positional argument is the function
NAME, not a path: the CLI resolves `delete-account` to
`supabase/functions/delete-account/` relative to the project directory. Passing
a path instead fails with `Invalid Function name. Must start with at least one
letter...`, because a path is not a legal name - and if the path is unquoted,
the space in this checkout's directory name splits it into two arguments first.

```bash
cd "/c/Users/.../iTala"

npx supabase@latest login          # once; opens a browser
npx supabase@latest functions deploy delete-account \
  --project-ref YOUR_SUPABASE_PROJECT --use-api

npx supabase@latest functions list --project-ref YOUR_SUPABASE_PROJECT
```

From anywhere else, point the CLI at the project with the global `--workdir`
flag instead of `cd`:

```bash
npx supabase@latest functions deploy delete-account \
  --project-ref YOUR_SUPABASE_PROJECT --use-api \
  --workdir "/c/Users/aeron.santos/Downloads/HEAS files/iTala"
```

Deploying succeeds whether or not the secrets are set - the function reads them
per request - so until all four exist it answers `500 configuration` and deletes
nothing. Both steps have to be done; the order does not matter.

`--use-api` bundles server-side, so Docker is not needed - relevant on Windows.
The CLI follows the relative import into `_shared/`, and a directory whose name
starts with `_` is not deployed as a function of its own.

**Do not pass `--no-verify-jwt`.** The function needs the caller's token and
refuses the request without one.

### Smoke test, no device needed

```bash
REF=YOUR_SUPABASE_PROJECT
ANON=$(grep -o 'EXPO_PUBLIC_SUPABASE_ANON_KEY=.*' ../../.env | cut -d= -f2-)

# 1. No credentials at all -> 401 from the gateway. Proves it is deployed.
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  "https://$REF.supabase.co/functions/v1/delete-account"

# 2. Anon key as the bearer -> reaches OUR handler, which asks GoTrue who this
#    is, gets nobody, and answers 401 invalid_session. Proves the code runs.
curl -s -X POST "https://$REF.supabase.co/functions/v1/delete-account" \
  -H "Authorization: Bearer $ANON" -H 'Content-Type: application/json' -d '{}'
```

Expect `401` then `{"error":"invalid_session",...}`. Neither touches Apple, so
neither proves the secrets are right - only R57 on a device does that.

JWT verification stays on (the default): the function needs the caller's token
and refuses the request without one.

**This is a manual step, and CI does not do it.** `npm test` type-checks and
exercises the function's logic, and the CI workflow runs that, but nothing in
this repository holds Supabase deployment credentials. A build shipped without
the function deployed will fail Apple-linked deletion with a readable error
rather than deleting anything - which is the correct failure, but it is still a
failure, so deploy before shipping an iOS build.

## End-to-end verification (device, manual, not automatable here)

`tests/appleRevocation.test.js` covers the JWT claims, both Apple request
bodies, the ordering and every failure branch against a fake Apple. It cannot
prove anything about the real endpoint. Do this on a real device, and record it
against **R57** in `tests/MANUAL-REGRESSION.md`:

1. Development or TestFlight build (**not** Expo Go), real Apple ID.
2. Sign in with Apple, accept the legal review, submit one content report so the
   retention disclosure applies to this account too.
3. On the device: *Settings → your name → Sign-In & Security → Sign in with
   Apple*. Confirm **iTala is listed**.
4. In iTala: *Settings → Delete account*. The confirmation must mention the
   Apple confirmation and the retained report identifier. Confirm.
5. Apple's sheet appears; confirm it.
6. Expect: "Account deleted", and the app returns to guest browsing.
7. Re-check step 3's list. **iTala must be gone.** This is the actual evidence
   of revocation; a green unit test is not.
8. Read the function log for one
   `{"fn":"delete-account","outcome":"revoked_and_deleted","detail":"refresh_token"}`
   line. The logs deliberately carry no user id and no token. There is **no
   `supabase functions logs` command** (CLI 2.116.0 offers only `list`,
   `delete`, `download`, `deploy`, `new`, `serve`), so read it in the dashboard:
   *Edge Functions → delete-account → Logs*.
9. Negative case: unset `APPLE_KEY_ID`, redeploy, repeat. Deletion must be
   **refused** with a readable message and the account must still exist. Restore
   the secret afterwards.
10. In the Supabase dashboard, confirm the `auth.users` row is gone, and that the
    `content_reports` row from step 2 is still present with its original
    `reporter_user_id` - the retention that the in-app dialog and privacy policy
    section 10 disclose.
