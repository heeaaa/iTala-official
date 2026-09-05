# iTala documentation

Everything here is a guide for a person doing a specific job. Start with the one
that matches the job.

| Doc | Read it when |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Understanding local persistence, derived statistics, synchronization, authorization and testing boundaries. |
| [AUTH_SETUP.md](AUTH_SETUP.md) | Wiring up Supabase Auth: Google, Sign in with Apple, anonymous sessions, the admin allowlist, and the backup password. **Also the first place to look when sign-in "doesn't work" in Expo Go** - the redirect allowlist is the usual cause. |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Shipping: EAS Build and Submit, App Store and Play Store listings, the privacy-policy site, and the store data-safety declarations. |
| [APP_REVIEW.md](APP_REVIEW.md) | Preparing App Store reviewer access, the test walkthrough, public URLs and Review Notes without committing credentials. |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Something is broken while developing: Expo Go won't connect, sign-in fails, the score behaves oddly. |
| [CODE_REVIEW.md](CODE_REVIEW.md) | The audit and remediation tracker. Every finding, its severity, whether it is fixed, and the evidence. Long; use the tables. |

## What lives elsewhere, and why

Docs that describe one directory live **in** that directory, so they are found by
someone already looking at the code rather than by someone who thought to check
a docs folder:

- [`../README.md`](../README.md) - what the app is, its product capabilities and quickstart.
  Stays at the repo root, where GitHub renders it.
- [`../CLAUDE.md`](../CLAUDE.md) - the engineering standard this repo is held to.
  Stays at the root because that is where Claude Code loads it from.
- [`../tests/README.md`](../tests/README.md) - what each suite covers and how to
  run the database checks.
- [`../tests/MANUAL-REGRESSION.md`](../tests/MANUAL-REGRESSION.md) - the checklist
  for everything automation cannot reach.
- [`../site/README.md`](../site/README.md) - the public pages and what they must
  stay consistent with.

## Keeping these honest

`tests/static.test.js` asserts on the content of these files, not just their
existence - the store declaration tables in DEPLOYMENT.md, the redirect guidance
in AUTH_SETUP.md. A section deleted here fails the build. CHECK 22 also fails the
build if any file in the repo references a doc path that does not exist, which is
what stops a future move from quietly breaking every link.
