---
description: Reproduce an iTala bug, prove the root cause, implement the smallest fix, add regression protection, and validate the behaviour
argument-hint: "<observed behaviour, expected behaviour, reproduction, logs/video path>"
disable-model-invocation: true
context: fork
agent: debugger
background: false
---

Investigate and fix this bug:

$ARGUMENTS

Do not stop at a plausible explanation or visible symptom. Reproduce when
possible, trace the complete relevant state/data path, test the hypothesis, add
meaningful regression protection, implement the smallest appropriate fix, and
report actual validation. If evidence is insufficient, say exactly what remains
unknown instead of claiming success.
