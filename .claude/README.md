# iTala Claude Code development system

This directory contains project-scoped specialists and repeatable workflows for
the actual iTala Expo/React Native application. Start Claude Code at the
repository root so it loads `CLAUDE.md`, `.claude/agents/`, and
`.claude/commands/`.

Use Claude Code 2.1.218 or newer. The direct commands use `context: fork`, a
named `agent`, and `background: false` so routing is isolated, deterministic,
and returns the specialist result in the invoking turn.

## Agents

| Agent | Responsibility | Default modification mode |
| --- | --- | --- |
| `architect` | Map existing patterns, dependencies, risks, and an implementation plan | Plan-only unless asked to implement |
| `debugger` | Reproduce, prove root cause, fix, regress, and validate bugs | May fix unless diagnosis-only |
| `test-engineer` | Add meaningful reducer/sync/static/SQL/manual regression protection | May edit tests and necessary code |
| `mobile-qa` | Test mobile interaction, lifecycle, offline states, accessibility, and platform risk | Review unless QA-and-fix |
| `offline-specialist` | Trace persistence, queueing, hydration, retry, restart, and cross-device consistency | Review unless asked to fix |
| `pr-reviewer` | Read-only whole-application PR review with P0-P3 findings | Always read-only |
| `performance-reviewer` | Establish and improve real rendering/data/network performance issues | Review unless asked to improve |
| `security-reviewer` | Review auth, authorization, RLS, RPC, storage, and exposure | Review unless asked to fix |
| `refactorer` | Make focused behaviour-preserving maintainability improvements | May refactor |

Agents read `.claude/PROJECT-CONTEXT.md` for the shared architecture map and
verify it against current code. Universal engineering and evidence rules remain
in `CLAUDE.md`.

## Commands

| Command | Purpose |
| --- | --- |
| `/plan-feature <request>` | Run the architect in isolated plan-only mode |
| `/debug <bug>` | Run the debugger end to end; overrides Claude Code's bundled debug-log skill in this project |
| `/test <change>` | Run the test engineer |
| `/qa <change>` | Run mobile QA; include “and fix” to authorize edits |
| `/review-pr [number]` | Orchestrate the read-only PR reviewer and high-severity spot checks |
| `/offline-review <change>` | Run the offline specialist; include “and fix” to authorize edits |
| `/performance <concern>` | Run evidence-based performance review |
| `/security <change>` | Run security/RLS review |
| `/refactor <area>` | Run a bounded behaviour-preserving refactor |
| `/feature <request>` | Architect → primary implementation → tests → mobile QA → conditional specialists |
| `/fix <bug>` | Debugger → test engineer → mobile QA → conditional specialists |
| `/release-check [target]` | Read-only PR, mobile, and risk-based domain review |
| `/validate-agents [--live ...]` | Validate structure and optionally run isolated live evaluations |

Simple specialist commands use Claude Code's forked-command `agent` routing so
the named specialist is selected deterministically. Multi-stage workflows stay
in the primary session, which owns integration and final verification.

## Recommended lifecycle

```text
Feature: /plan-feature → implement (or /feature) → /test → /qa → PR → /review-pr
Bug:     /debug → /test → /qa → PR → /review-pr
Release: /release-check
```

Agents can also be invoked directly:

```text
Use the offline-specialist agent to review this reconnect flow. Do not edit.
Use the mobile-qa agent to QA-and-fix the current branch on iOS and Android.
Use the security-reviewer agent to review the new RPC and its RLS policy.
```

Run `npm run agents:validate` after changing an agent, command, shared context,
scenario, or validation script.

Because the project defines `/debug`, use the CLI `claude --debug` flag when you
need Claude Code's session debug logging rather than application bug diagnosis.
