---
description: Review an iTala change across authentication, authorization, RLS, RPCs, sessions, storage, input, and data exposure
argument-hint: "<change or security concern; add 'and fix' to authorize fixes>"
disable-model-invocation: true
context: fork
agent: security-reviewer
background: false
---

Perform a security review of:

$ARGUMENTS

Trace the actual client and Supabase schema/RLS boundary, verify reachability,
and report only actionable findings. Modify code or schema only if the request
explicitly includes "fix". Never change production resources or credentials.
