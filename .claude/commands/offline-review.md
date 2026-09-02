---
description: Trace an iTala change through local persistence, pending writes, ordered pushes, hydration, retries, reconnect, restart, and cross-device consistency
argument-hint: "<change or offline scenario; add 'and fix' to authorize fixes>"
disable-model-invocation: true
context: fork
agent: offline-specialist
background: false
---

Review the complete offline and synchronization behaviour of:

$ARGUMENTS

Inspect the entire relevant persistence/sync path, not only changed files or
network calls. Include an event timeline and real-client error semantics.
Modify code only when the request explicitly includes "fix"; otherwise return
high-confidence findings, verification, and residual device scenarios.
