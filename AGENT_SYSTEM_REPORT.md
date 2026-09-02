# iTala Claude Code agent system report

Generated from repository commit `c1a8319` on 2026-09-02. Application feature
code was not modified.

## Agent system

| Agent | Responsibility |
| --- | --- |
| `architect` | Finds existing patterns and produces a dependency-, risk-, and validation-aware feature plan; implements only when explicitly asked. |
| `debugger` | Reproduces bugs, proves root cause across the complete state/data path, implements the smallest fix, and adds regression protection. |
| `test-engineer` | Selects the correct reducer, sync, static, SQL, or manual test layer; writes and runs meaningful tests. |
| `mobile-qa` | Reviews real mobile journeys across touch, layout, navigation, lifecycle, connectivity, accessibility, and platform differences. |
| `offline-specialist` | Traces AsyncStorage, pending writes, ordered pushes, Supabase results, hydration, reconnect, restart, and cross-device consistency. |
| `pr-reviewer` | Performs read-only, whole-application PR review with evidence-backed P0-P3 findings. |
| `performance-reviewer` | Establishes reachable, measured or proxy-supported performance issues before making improvements. |
| `security-reviewer` | Reviews client auth through Supabase RLS/RPC/grant boundaries, storage, input, sessions, and data exposure. |
| `refactorer` | Makes focused, reversible, behaviour-preserving maintainability improvements after mapping all consumers. |

Shared iTala architecture and invariants live in
`.claude/PROJECT-CONTEXT.md`; universal engineering rules stay in `CLAUDE.md`.

## Commands

| Command | Action |
| --- | --- |
| `/plan-feature <request>` | Isolated, enforced read-only architect plan |
| `/debug <bug>` | Debugger investigation, fix, regression test, and validation |
| `/test <change>` | Test-engineer analysis, implementation, and execution |
| `/qa <change>` | Mobile QA; add “and fix” to authorize changes |
| `/review-pr [PR]` | Existing PR-review workflow with read-only enforcement |
| `/offline-review <change>` | Full offline/sync review; add “and fix” to authorize changes |
| `/performance <concern>` | Evidence-based performance review/improvement |
| `/security <change>` | Auth/RLS/security review; add “and fix” to authorize changes |
| `/refactor <area>` | Bounded behaviour-preserving refactor |
| `/feature <request>` | Architect → implementation → test engineer → mobile QA → relevant specialists |
| `/fix <bug>` | Debugger → test engineer → mobile QA → relevant specialists |
| `/release-check [target]` | Read-only, risk-based PR/mobile/offline/performance/security review |
| `/validate-agents [--live ...]` | Structural validation and optional isolated live evaluations |

The direct specialist commands use current Claude Code forked command routing
(`context: fork`, named `agent`, `background: false`). The project-local
`/debug` intentionally replaces Claude Code's bundled debug-log skill; use
`claude --debug` for CLI session logging.

## Recommended workflow

```text
Feature
  ↓
/plan-feature (or /feature for orchestration)
  ↓
Implement
  ↓
/test
  ↓
/qa
  ↓
PR
  ↓
/review-pr
```

```text
Bug
  ↓
/debug (or /fix for orchestration)
  ↓
/test
  ↓
/qa
  ↓
PR
  ↓
/review-pr
```

## Validation

### Deterministic checks executed

```text
node .claude/scripts/validate-agent-system.mjs
PASS — 601 structural checks
9 agents, 13 commands, 9 scenarios

node tests/static.test.js
PASS — 415 static checks, 0 failures, 2 pre-existing warnings

node --check .claude/scripts/validate-agent-system.mjs
PASS

node --check .claude/scripts/run-agent-evals.mjs
PASS

git diff --check
PASS
```

The structural suite checks supported frontmatter, unique names, required
sections, command routing, read-only controls, centralized project context,
scenario coverage, live-fixture applicability, and referenced repository paths.

### Agent scenarios

| Agent | Repository-backed scenario | Structural status | Live status / limitation |
| --- | --- | --- | --- |
| `architect` | Period-aware team fouls using existing event/stat/state patterns | PASS | NOT RUN — Claude Code CLI unavailable here |
| `debugger` | Deliberately bypassed push queue causing undo/refresh resurrection | PASS | NOT RUN — Claude Code CLI unavailable here |
| `test-engineer` | Rejected push must not poison the serialized queue | PASS | NOT RUN — Claude Code CLI unavailable here |
| `mobile-qa` | Stat → offline refresh → background/resume → reconnect journey | PASS | NOT RUN — no Claude CLI, device, or emulator |
| `offline-specialist` | Offline write plus restart/reconnect and stale hydrate | PASS | NOT RUN — Claude Code CLI unavailable here |
| `pr-reviewer` | PR fixture bypassing ordered push dispatch | PASS, including read-only enforcement | NOT RUN — Claude Code CLI unavailable here |
| `performance-reviewer` | Several-hundred-event LiveGame slowdown | PASS | NOT RUN — no Claude CLI or device profiler |
| `security-reviewer` | Ordinary user attempting roster administration through RLS | PASS | NOT RUN — no Claude CLI or live Supabase project |
| `refactorer` | Behaviour-preserving live-input helper boundary refactor | PASS | NOT RUN — Claude Code CLI unavailable here |

Live scenarios are ready to run in disposable repository copies:

```bash
node .claude/scripts/run-agent-evals.mjs --list
node .claude/scripts/run-agent-evals.mjs --agent debugger
node .claude/scripts/run-agent-evals.mjs --all
```

### Other limitations

- `npm ci`, the complete `npm test`, ESLint, and Expo bundle export were not run
  because this environment could not access the npm registry and had no cached
  dependency set. The dependency-free project static suite did run.
- GitHub Actions did not run because these changes were not pushed or opened as
  a PR. No CI status is claimed.
- No device/emulator, real Supabase project, screen reader, or native build was
  available. Those boundaries remain manual/live evidence, not inferred passes.

## Files created or modified

- Root: `CLAUDE.md`, `.gitignore`, `package.json`, `AGENT_SYSTEM_REPORT.md`
- Shared agent docs: `.claude/README.md`, `.claude/PROJECT-CONTEXT.md`
- Agents: all nine files under `.claude/agents/`
- Commands: all thirteen files under `.claude/commands/`
- Validation: `.claude/validation/README.md`,
  `.claude/validation/scenarios.json`
- Scripts: `.claude/scripts/validate-agent-system.mjs`,
  `.claude/scripts/run-agent-evals.mjs`

## Usage

Use Claude Code 2.1.218 or newer, start it from the repository root, and invoke
the slash commands above. After changing the system, run:

```bash
npm run agents:validate
```

For direct routing without a command:

```text
Use the offline-specialist agent to review this reconnect flow. Do not edit.
Use the mobile-qa agent to QA-and-fix the current branch on iOS and Android.
Use the security-reviewer agent to review the new RPC and its RLS policy.
```
