---
description: Orchestrate an iTala feature from architecture through implementation, regression tests, mobile QA, and final evidence
argument-hint: "<feature request, constraints, and acceptance criteria>"
disable-model-invocation: true
---

Deliver this feature end to end:

$ARGUMENTS

The primary session owns integration and final truth. Follow this gated flow:

1. Delegate repository analysis and a file-specific plan to `architect`. Do not
   implement before reading its plan and checking assumptions against the code.
2. Present or establish the plan. If a missing user decision materially changes
   behaviour, stop for clarification. Otherwise implement the smallest coherent
   change in the primary session using existing patterns.
3. Delegate regression analysis and test implementation to `test-engineer`.
   Inspect and integrate its changes; do not treat its report as independent
   proof until the primary session reruns relevant checks.
4. Delegate mobile-focused review to `mobile-qa`. Ask it to review rather than
   edit unless QA-and-fix is within the user's request. Resolve confirmed issues.
5. Invoke `offline-specialist`, `security-reviewer`, or `performance-reviewer`
   only when the feature actually crosses those concerns.
6. Run final relevant tests, lint/type/bundle checks, inspect the whole diff, and
   report PASS/FAIL/NOT RUN with exact evidence and remaining risks.

Do not let agents edit the same files concurrently. Do not commit, push, open a
PR, or change external resources unless the user requested it.
