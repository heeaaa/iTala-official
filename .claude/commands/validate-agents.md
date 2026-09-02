---
description: Validate the iTala Claude agent system structure and optionally run isolated live-agent scenarios when Claude Code is installed and authenticated
argument-hint: "[--live <agent>|--live --all]"
disable-model-invocation: true
---

Validate the agent system, not the mobile application feature code.

1. Run `node .claude/scripts/validate-agent-system.mjs` and report its exact
   result. Fix structural failures inside `.claude/` when requested.
2. If `$ARGUMENTS` includes `--live`, first confirm `claude --version` works.
   Then run `node .claude/scripts/run-agent-evals.mjs` with the remaining live
   arguments. Live evaluations use detached temporary worktrees so implementation
   agents cannot alter the current checkout.
3. Never present structural validation as proof of model behaviour. Report live
   scenarios separately, including authentication/tooling limitations.

Arguments: $ARGUMENTS
