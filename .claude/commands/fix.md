---
description: Orchestrate an iTala bug fix from root-cause investigation through implementation, regression testing, mobile QA, and final verification
argument-hint: "<bug report, expected behaviour, reproduction, logs/video path>"
disable-model-invocation: true
---

Fix this bug end to end:

$ARGUMENTS

Use this gated flow:

1. Delegate reproduction, root-cause proof, minimal implementation, and an
   initial regression test to `debugger`.
2. Inspect its evidence and diff in the primary session. Reject symptom patches,
   assumptions presented as facts, or claims unsupported by executed checks.
3. Delegate independent regression analysis to `test-engineer`; integrate only
   meaningful tests and rerun them in the primary session.
4. Delegate affected mobile journeys to `mobile-qa`. Use `offline-specialist`
   for any persistence, refresh, reconnect, restart, or disappearing-data path;
   use security/performance reviewers only when material.
5. Run final relevant checks and inspect the complete diff. Report root cause,
   why the fix addresses it, actual validation, and anything not run.

Do not commit, push, open a PR, or change external resources unless requested.
