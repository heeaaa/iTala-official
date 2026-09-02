---
description: Run a read-only, risk-based iTala release review using whole-application PR review, mobile QA, and only relevant domain specialists
argument-hint: "[PR number, branch, or current change] [release concerns]"
disable-model-invocation: true
disallowed-tools: Edit, Write, NotebookEdit
---

Perform a read-only release check for:

$ARGUMENTS

1. Establish the exact diff/PR and intended behaviour.
2. Delegate the whole-application code review to `pr-reviewer`.
3. Delegate affected user journeys to `mobile-qa` in review-only mode.
4. Invoke `offline-specialist` when persistence, sync, refresh, reconnect, or
   mutations changed; `performance-reviewer` when scale/latency paths changed;
   and `security-reviewer` when auth, schema, RLS, sensitive input/data, or a new
   server boundary changed. Do not run specialists merely to fill a checklist.
5. Reconcile findings against evidence, deduplicate shared causes, and spot-check
   P0/P1 factual premises. Report actual CI separately from local checks.

Do not modify files, post comments, merge, deploy, or change external state.
Return a release verdict with blockers, actionable lower-severity findings,
verification evidence, device/manual gaps, and remaining risk.
