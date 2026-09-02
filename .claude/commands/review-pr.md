---
description: Review an open pull request against the whole application using the pr-reviewer agent
argument-hint: "[PR number, branch, or nothing for the current branch]"
---

Review a pull request with the **pr-reviewer** agent.

Target: $ARGUMENTS

Resolve the target first, then delegate. Do not review it yourself - the
pr-reviewer agent exists so the review starts from the application rather than
from the diff, and running it inline in a session that already has opinions
about the code defeats that.

1. Work out which PR is meant:
   - A number in the target: that PR.
   - A branch name: the PR open for that branch (`gh pr list --head <branch>`).
   - Nothing: the PR for the current branch (`gh pr view --json number,title,url`).
   - No PR for the current branch: say so, and offer to review the branch
     against its merge base with `main` instead. Do not silently review
     something the user did not ask for.

2. Launch the `pr-reviewer` subagent with the resolved target. Tell it the PR
   number and URL, and pass along any extra instruction the user gave in
   `$ARGUMENTS` (an area to focus on, a concern to check). Give it nothing else -
   in particular, do not summarise the diff or your own view of it. A briefed
   reviewer is a biased reviewer, and its whole method depends on reaching the
   diff last.

3. Relay its review to the user **verbatim**, in the structure it returns. The
   agent's output is not shown to the user directly, so it has to come through
   you. Do not soften a verdict, re-rank findings, drop the ones you disagree
   with, or add your own.

If you do disagree with something after reading it, say so in one short note
**after** the review, marked as your own opinion, with the evidence for it.

Do not fix anything. This is a review. Wait for the user to decide what to do
with it.
