---
description: Safely refactor a bounded iTala area while preserving behaviour, mapping all consumers, and validating equivalence
argument-hint: "<specific area and maintainability goal>"
disable-model-invocation: true
context: fork
agent: refactorer
background: false
---

Refactor this bounded area:

$ARGUMENTS

Map the existing contract and every consumer first. Use small reversible
transformations, preserve observable behaviour and serialized/server contracts,
run appropriate characterization and regression checks, and stop if the work
requires a product behaviour decision.
