---
description: Perform mobile-focused QA for an iTala change across device, interaction, lifecycle, offline, error, and accessibility scenarios
argument-hint: "<feature/change; platforms; add 'and fix' to authorize fixes>"
disable-model-invocation: true
context: fork
agent: mobile-qa
background: false
---

Perform mobile QA on:

$ARGUMENTS

Exercise available tools and tests rather than doing only a static review. Make
clear which behaviours were observed on a device/emulator and which were only
source-inspected. Modify code only if the request explicitly includes "fix";
otherwise report reproducible issues and the evidence needed to confirm them.
