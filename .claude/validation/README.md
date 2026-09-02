# Agent validation

The validation system separates configuration correctness from model behaviour.

## Structural validation

Run `npm run agents:validate`. This deterministic check verifies required agents
and commands, unique agent names, supported frontmatter, read-only PR-review
restrictions, command-to-agent routing, shared project context,
repository-backed scenario paths, and one scenario for every specialist. It
does not invoke a model.

## Live behaviour evaluation

An authenticated Claude Code CLI is required.

```bash
node .claude/scripts/run-agent-evals.mjs --list
node .claude/scripts/run-agent-evals.mjs --agent debugger
node .claude/scripts/run-agent-evals.mjs --all
```

Every run copies the repository into a temporary directory, initializes a local
baseline commit, applies scenario setup, and runs `claude --agent <name> -p`
there. Implementation agents can edit only that disposable copy. The runner
grades required path/output evidence, forbidden claims, exit status, and
read-only cleanliness, then removes the copy.

Heuristic grading is a smoke test, not proof that an agent's conclusion is
correct. Review the transcript and diff summary for material decisions.
