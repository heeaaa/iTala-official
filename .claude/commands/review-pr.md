---
description: Review an open pull request against the whole application using the pr-reviewer agent
argument-hint: "[PR number, branch, or nothing for the current branch]"
disable-model-invocation: true
disallowed-tools: Edit, Write, NotebookEdit
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

3. **Spot-check every P0 and P1 before you present it as established.** Not the
   whole finding - the single factual claim it rests on. If it says a library
   behaves a certain way, run it. If it says a caller exists, grep for it. If it
   says a line reads something, open the line.

   This is not distrust of the agent, it is the standard `CLAUDE.md` sections 39
   and 47 set: agent output ranks below evidence, and agreement between models
   is not proof. It is also cheap - the checks are seconds each - and it is not
   optional, because a subagent's transcript is not reliably retained, so its
   claimed verification cannot be audited after the fact. Yours is the last
   point at which a wrong P1 can be caught before somebody acts on it.

   Report what the spot-check found, including when it contradicts the agent.

4. Relay the review to the user **verbatim**, in the structure it returns. The
   agent's output is not shown to the user directly, so it has to come through
   you. Do not soften a verdict, re-rank findings, drop the ones you disagree
   with, or fold your own opinions into its text.

   Add your spot-check results, and any disagreement of your own, in a short
   note **after** the review, marked as yours, with the evidence.

5. Offer to post the review as a PR comment. Do **not** post it without being
   asked: a review comment is visible to everyone on the repository and is not
   easily taken back, and the user may want to act on it privately first.

Do not fix anything. This is a review. Wait for the user to decide what to do
with it.
