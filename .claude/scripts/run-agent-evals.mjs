#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..', '..');
const scenarios = JSON.parse(fs.readFileSync(
  path.join(root, '.claude', 'validation', 'scenarios.json'),
  'utf8',
));

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const filteredArgs = args.filter(arg => arg !== '--keep');

function usage() {
  console.log('Usage:');
  console.log('  node .claude/scripts/run-agent-evals.mjs --list');
  console.log('  node .claude/scripts/run-agent-evals.mjs --agent <name> [--keep]');
  console.log('  node .claude/scripts/run-agent-evals.mjs --all [--keep]');
}

if (filteredArgs.length === 0 || filteredArgs.includes('--list')) {
  for (const scenario of scenarios) {
    console.log(`${scenario.agent.padEnd(22)} ${scenario.id} ${scenario.mayModify ? '[isolated edits]' : '[read-only]'}`);
  }
  if (filteredArgs.length === 0) usage();
  process.exit(0);
}

let selected;
if (filteredArgs.includes('--all')) {
  selected = scenarios;
} else {
  const index = filteredArgs.indexOf('--agent');
  const name = index >= 0 ? filteredArgs[index + 1] : null;
  if (!name) {
    usage();
    process.exit(2);
  }
  selected = scenarios.filter(scenario => scenario.agent === name || scenario.id === name);
  if (selected.length === 0) {
    console.error(`No scenario found for ${name}`);
    process.exit(2);
  }
}

const version = spawnSync('claude', ['--version'], { encoding: 'utf8' });
if (version.error?.code === 'ENOENT') {
  console.error('NOT RUN — Claude Code CLI is not installed or not on PATH');
  process.exit(2);
}
if (version.status !== 0) {
  console.error(`NOT RUN — claude --version failed: ${(version.stderr || version.stdout).trim()}`);
  process.exit(2);
}
console.log(`Claude Code: ${version.stdout.trim()}`);

function run(command, commandArgs, cwd, options = {}) {
  return spawnSync(command, commandArgs, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
    env: process.env,
  });
}

function requireSuccess(result, label) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  }
}

function copyRepository(destination) {
  fs.cpSync(root, destination, {
    recursive: true,
    filter(source) {
      const relative = path.relative(root, source);
      if (!relative) return true;
      const first = relative.split(path.sep)[0];
      return !['.git', 'node_modules', 'dist', '.expo'].includes(first);
    },
  });
}

function initializeBaseline(workspace) {
  requireSuccess(run('git', ['init', '-q'], workspace), 'git init');
  requireSuccess(run('git', ['config', 'user.name', 'iTala agent evaluator'], workspace), 'git config user.name');
  requireSuccess(run('git', ['config', 'user.email', 'agent-eval@invalid.local'], workspace), 'git config user.email');
  requireSuccess(run('git', ['add', '-A'], workspace), 'git add baseline');
  requireSuccess(run('git', ['commit', '-q', '-m', 'agent evaluation baseline'], workspace), 'git commit baseline');
}

function applySetup(workspace, scenario) {
  for (const transform of scenario.setupTransforms ?? []) {
    const target = path.join(workspace, transform.file);
    const current = fs.readFileSync(target, 'utf8');
    if (!current.includes(transform.from)) {
      throw new Error(`setup transform no longer matches ${transform.file}`);
    }
    fs.writeFileSync(target, current.replace(transform.from, transform.to));
  }
  // Reviewer scenarios need a visible working-tree diff to review. For
  // implementation scenarios, commit the deliberately broken fixture so the
  // agent's own repair is the only post-run diff.
  if ((scenario.setupTransforms ?? []).length > 0 && scenario.agent !== 'pr-reviewer') {
    requireSuccess(run('git', ['add', '-A'], workspace), 'git add scenario setup');
    requireSuccess(run('git', ['commit', '-q', '-m', `scenario setup: ${scenario.id}`], workspace),
      'git commit scenario setup');
  }
}

function resultText(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed.result === 'string') return parsed.result;
    if (Array.isArray(parsed.content)) {
      return parsed.content.map(item => item.text ?? '').join('\n');
    }
  } catch {
    // A version or host can emit plain text despite the requested output mode.
  }
  return stdout;
}

function grade(scenario, execution, workspace, beforeDiff) {
  const output = resultText(execution.stdout ?? '');
  const lower = output.toLowerCase();
  const diff = run('git', ['diff', '--name-only'], workspace);
  requireSuccess(diff, 'git diff');
  const changedFiles = diff.stdout.trim().split('\n').filter(Boolean);
  const fullDiff = run('git', ['diff', '--binary'], workspace);
  requireSuccess(fullDiff, 'git diff --binary');
  const failures = [];

  if (execution.error) failures.push(`Claude process error: ${execution.error.message}`);
  if (execution.status !== 0) {
    failures.push(`Claude exited ${execution.status}: ${(execution.stderr || '').trim()}`);
  }
  for (const required of scenario.requiredPaths) {
    if (!lower.includes(required.toLowerCase())) failures.push(`output did not cite ${required}`);
  }
  for (const required of scenario.requiredEvidence) {
    if (!lower.includes(required.toLowerCase())) failures.push(`output missing evidence marker: ${required}`);
  }
  for (const forbidden of scenario.forbiddenClaims ?? []) {
    if (lower.includes(forbidden.toLowerCase())) failures.push(`output used forbidden claim: ${forbidden}`);
  }
  if (!scenario.mayModify && fullDiff.stdout !== beforeDiff) {
    failures.push('read-only agent changed the scenario working tree');
  }
  if (scenario.mayModify && fullDiff.stdout === beforeDiff) {
    failures.push('implementation scenario produced no file changes');
  }

  return { output, changedFiles, failures };
}

const summaries = [];
for (const scenario of selected) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `itala-${scenario.id}-`));
  console.log(`\nRUN ${scenario.id}`);
  try {
    copyRepository(workspace);
    initializeBaseline(workspace);
    applySetup(workspace, scenario);
    const before = run('git', ['diff', '--binary'], workspace);
    requireSuccess(before, 'git diff before evaluation');

    const evaluationPrompt = [
      scenario.prompt,
      '',
      'Evaluation requirements:',
      '- Follow the agent definition, CLAUDE.md, and .claude/PROJECT-CONTEXT.md.',
      '- Cite every repository path you inspect in the final response.',
      '- Use PASS, FAIL, NOT RUN, and NOT APPLICABLE accurately.',
      '- Do not commit, push, open a PR, or access external production resources.',
    ].join('\n');

    const execution = run('claude', [
      '--agent', scenario.agent,
      '--permission-mode', scenario.mayModify ? 'acceptEdits' : 'plan',
      '--output-format', 'json',
      '-p', evaluationPrompt,
    ], workspace, { timeout: 20 * 60_000 });

    const graded = grade(scenario, execution, workspace, before.stdout);
    const passed = graded.failures.length === 0;
    console.log(`${passed ? 'PASS' : 'FAIL'} ${scenario.id}`);
    console.log(`Changed files: ${graded.changedFiles.join(', ') || 'none'}`);
    if (!passed) for (const failure of graded.failures) console.log(`- ${failure}`);
    console.log('--- Agent output ---');
    console.log(graded.output.trim());
    console.log('--- End output ---');
    summaries.push({ id: scenario.id, agent: scenario.agent, passed, ...graded });
  } catch (error) {
    console.log(`FAIL ${scenario.id}`);
    console.log(`- evaluator error: ${error.message}`);
    summaries.push({ id: scenario.id, agent: scenario.agent, passed: false, failures: [error.message] });
  } finally {
    if (keep) console.log(`Kept isolated workspace: ${workspace}`);
    else fs.rmSync(workspace, { recursive: true, force: true });
  }
}

const passed = summaries.filter(summary => summary.passed).length;
console.log(`\nRESULT ${passed}/${summaries.length} live scenarios passed heuristic grading`);
process.exit(passed === summaries.length ? 0 : 1);
