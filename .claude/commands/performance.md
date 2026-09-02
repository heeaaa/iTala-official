---
description: Investigate an iTala performance concern with measurements or reproducible proxies and implement only justified improvements when requested
argument-hint: "<slow behaviour/change; data size/device; add 'and improve' to authorize edits>"
disable-model-invocation: true
context: fork
agent: performance-reviewer
background: false
---

Review this performance concern:

$ARGUMENTS

Establish reachability and a baseline before recommending optimization.
Distinguish measured defects, proxy-supported risks, and theory. Modify code only
when the request explicitly asks to improve or fix it, and compare before/after
without changing behaviour or introducing stale cached totals.
