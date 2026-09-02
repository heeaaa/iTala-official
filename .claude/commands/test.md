---
description: Design and implement meaningful iTala tests for the current change, run the relevant suites, and diagnose failures or coverage gaps
argument-hint: "<change, feature, bug, diff, or failing check>"
disable-model-invocation: true
context: fork
agent: test-engineer
background: false
---

Test this work using the repository's existing strategy:

$ARGUMENTS

Inspect the behaviour and current tests first. Add only meaningful regression
coverage, run the focused and appropriately broad suites, distinguish SQL skip
from pass, and update the manual regression checklist for device-only behaviour.
Do not weaken tests to make them green.
