#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..', '..');
const agentDir = path.join(root, '.claude', 'agents');
const commandDir = path.join(root, '.claude', 'commands');

const requiredAgents = [
  'architect',
  'debugger',
  'test-engineer',
  'mobile-qa',
  'offline-specialist',
  'pr-reviewer',
  'performance-reviewer',
  'security-reviewer',
  'refactorer',
];

const requiredCommands = [
  'plan-feature',
  'debug',
  'test',
  'qa',
  'review-pr',
  'offline-review',
  'performance',
  'refactor',
  'security',
  'feature',
  'fix',
  'release-check',
  'validate-agents',
];

const directRoutes = {
  'plan-feature': 'architect',
  debug: 'debugger',
  test: 'test-engineer',
  qa: 'mobile-qa',
  'offline-review': 'offline-specialist',
  performance: 'performance-reviewer',
  refactor: 'refactorer',
  security: 'security-reviewer',
};

const orchestrationRoutes = {
  'review-pr': ['pr-reviewer'],
  feature: ['architect', 'test-engineer', 'mobile-qa'],
  fix: ['debugger', 'test-engineer', 'mobile-qa'],
  'release-check': [
    'pr-reviewer',
    'mobile-qa',
    'offline-specialist',
    'performance-reviewer',
    'security-reviewer',
  ],
};

const allowedAgentKeys = new Set([
  'name',
  'description',
  'tools',
  'disallowedTools',
  'model',
  'permissionMode',
  'mcpServers',
  'hooks',
  'maxTurns',
  'skills',
  'initialPrompt',
  'memory',
  'effort',
  'background',
  'isolation',
]);

const allowedCommandKeys = new Set([
  'description',
  'argument-hint',
  'arguments',
  'disable-model-invocation',
  'user-invocable',
  'allowed-tools',
  'disallowed-tools',
  'model',
  'effort',
  'context',
  'agent',
  'background',
  'hooks',
  'shell',
  'metadata',
  'license',
  'compatibility',
]);

let passes = 0;
const failures = [];

function check(condition, label, detail = '') {
  if (condition) {
    passes += 1;
  } else {
    failures.push(detail ? `${label}: ${detail}` : label);
  }
}

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function markdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .sort();
}

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(relative) {
  const text = read(relative).replaceAll('\r\n', '\n');
  check(text.startsWith('---\n'), `${relative} has opening frontmatter delimiter`);
  const end = text.indexOf('\n---\n', 4);
  check(end >= 0, `${relative} has closing frontmatter delimiter`);
  if (!text.startsWith('---\n') || end < 0) return { meta: {}, body: text };

  const meta = {};
  for (const line of text.slice(4, end).split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    check(Boolean(match), `${relative} frontmatter line is parseable`, line);
    if (!match) continue;
    meta[match[1]] = unquote(match[2]);
  }
  return { meta, body: text.slice(end + 5) };
}

function csv(value = '') {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

check(fs.existsSync(path.join(root, '.claude', 'PROJECT-CONTEXT.md')),
  'shared project context exists');
check(fs.existsSync(path.join(root, '.claude', 'README.md')),
  'agent-system usage guide exists');
check(fs.existsSync(path.join(root, '.claude', 'validation', 'README.md')),
  'validation guide exists');

const agentFiles = markdownFiles(agentDir);
const agentNames = [];
const agents = new Map();

for (const file of agentFiles) {
  const relative = `.claude/agents/${file}`;
  const { meta, body } = parseFrontmatter(relative);
  const expectedName = path.basename(file, '.md');

  check(meta.name === expectedName, `${relative} name matches filename`,
    `expected ${expectedName}, got ${meta.name ?? '<missing>'}`);
  check(Boolean(meta.description), `${relative} has a routing description`);
  check(Boolean(meta.tools), `${relative} declares an explicit tool set`);
  check(['inherit', 'opus', 'sonnet', 'haiku', 'fable'].includes(meta.model),
    `${relative} has a supported model value`, meta.model ?? '<missing>');
  if (meta.effort) {
    check(['low', 'medium', 'high', 'xhigh', 'max'].includes(meta.effort),
      `${relative} has a supported effort value`, meta.effort);
  }
  for (const key of Object.keys(meta)) {
    check(allowedAgentKeys.has(key), `${relative} uses supported agent frontmatter`, key);
  }
  check(body.includes('CLAUDE.md'), `${relative} loads project engineering rules`);
  check(body.includes('.claude/PROJECT-CONTEXT.md'), `${relative} loads shared app context`);

  if (expectedName !== 'pr-reviewer') {
    check(/## (Workflow|Inputs and mode)/.test(body), `${relative} defines inputs/workflow`);
    check(body.includes('## Output'), `${relative} defines an output contract`);
    check(/validat|Verification/i.test(body), `${relative} defines validation expectations`);
    check(/escalat/i.test(body), `${relative} defines specialist escalation`);
  }

  agentNames.push(meta.name);
  agents.set(meta.name, { meta, body, relative });
}

for (const name of requiredAgents) {
  check(agents.has(name), `required agent ${name} exists`);
}
check(new Set(agentNames).size === agentNames.length, 'agent names are unique');

const pr = agents.get('pr-reviewer');
if (pr) {
  const tools = csv(pr.meta.tools);
  const denied = csv(pr.meta.disallowedTools);
  check(!tools.includes('Edit') && !tools.includes('Write') && !tools.includes('NotebookEdit'),
    'pr-reviewer tool allowlist is read-only');
  check(denied.includes('Edit') && denied.includes('Write'),
    'pr-reviewer explicitly denies write tools');
  check(/never modif/i.test(pr.body), 'pr-reviewer body forbids modifications');
}

const commandFiles = markdownFiles(commandDir);
const commands = new Map();
for (const file of commandFiles) {
  const name = path.basename(file, '.md');
  const relative = `.claude/commands/${file}`;
  const { meta, body } = parseFrontmatter(relative);

  check(Boolean(meta.description), `${relative} has a description`);
  check(meta['disable-model-invocation'] === 'true', `${relative} is explicitly user-invoked`);
  check(body.includes('$ARGUMENTS'), `${relative} accepts task arguments`);
  for (const key of Object.keys(meta)) {
    check(allowedCommandKeys.has(key), `${relative} uses supported command frontmatter`, key);
  }
  commands.set(name, { meta, body, relative });
}

for (const name of requiredCommands) {
  check(commands.has(name), `required command /${name} exists`);
}

for (const [command, agent] of Object.entries(directRoutes)) {
  const entry = commands.get(command);
  if (!entry) continue;
  check(entry.meta.context === 'fork', `/${command} runs in isolated fork context`);
  check(entry.meta.agent === agent, `/${command} routes to ${agent}`,
    `got ${entry.meta.agent ?? '<missing>'}`);
  check(entry.meta.background === 'false', `/${command} waits for ${agent} result`);
}

for (const [command, routedAgents] of Object.entries(orchestrationRoutes)) {
  const entry = commands.get(command);
  if (!entry) continue;
  for (const agent of routedAgents) {
    check(entry.body.includes(`\`${agent}\``), `/${command} invokes ${agent}`);
  }
}

for (const name of ['review-pr', 'release-check']) {
  const entry = commands.get(name);
  if (!entry) continue;
  const denied = csv(entry.meta['disallowed-tools']);
  check(denied.includes('Edit') && denied.includes('Write'),
    `/${name} denies write tools`);
}

{
  const entry = commands.get('plan-feature');
  if (entry) {
    const denied = csv(entry.meta['disallowed-tools']);
    check(denied.includes('Edit') && denied.includes('Write'),
      '/plan-feature enforces plan-only tools');
  }
}

const context = read('.claude/PROJECT-CONTEXT.md');
for (const marker of [
  'StoreProvider.tsx',
  'storage.ts',
  'pendingEvents.ts',
  'pushQueue.ts',
  'supabase/schema.sql',
  'tests/MANUAL-REGRESSION.md',
  'enqueuePush',
  'checkCritical',
]) {
  check(context.includes(marker), 'shared context includes critical project marker', marker);
}

const scenariosPath = path.join(root, '.claude', 'validation', 'scenarios.json');
check(fs.existsSync(scenariosPath), 'validation scenarios file exists');
let scenarios = [];
try {
  scenarios = JSON.parse(fs.readFileSync(scenariosPath, 'utf8'));
  check(Array.isArray(scenarios), 'validation scenarios parse as an array');
} catch (error) {
  failures.push(`validation scenarios parse: ${error.message}`);
}

const scenarioAgents = new Set();
const scenarioIds = new Set();
for (const scenario of scenarios) {
  check(typeof scenario.id === 'string' && scenario.id.length > 0, 'scenario has an id');
  check(!scenarioIds.has(scenario.id), 'scenario ids are unique', scenario.id);
  scenarioIds.add(scenario.id);
  check(requiredAgents.includes(scenario.agent), `${scenario.id} targets a known agent`, scenario.agent);
  scenarioAgents.add(scenario.agent);
  check(typeof scenario.prompt === 'string' && scenario.prompt.length >= 80,
    `${scenario.id} has a representative prompt`);
  check(typeof scenario.mayModify === 'boolean', `${scenario.id} declares modification policy`);
  check(Array.isArray(scenario.requiredPaths) && scenario.requiredPaths.length >= 2,
    `${scenario.id} requires repository evidence`);
  for (const relative of scenario.requiredPaths ?? []) {
    check(fs.existsSync(path.join(root, relative)), `${scenario.id} evidence path exists`, relative);
  }
  check(Array.isArray(scenario.requiredEvidence) && scenario.requiredEvidence.length > 0,
    `${scenario.id} declares output evidence`);
  for (const transform of scenario.setupTransforms ?? []) {
    const target = path.join(root, transform.file ?? '');
    check(fs.existsSync(target), `${scenario.id} setup target exists`, transform.file);
    if (fs.existsSync(target)) {
      check(fs.readFileSync(target, 'utf8').includes(transform.from),
        `${scenario.id} setup transform matches current source`, transform.file);
    }
  }
}

for (const agent of requiredAgents) {
  check(scenarioAgents.has(agent), `${agent} has a representative validation scenario`);
}

const packageJson = JSON.parse(read('package.json'));
check(packageJson.scripts?.['agents:validate'] === 'node .claude/scripts/validate-agent-system.mjs',
  'package.json exposes agents:validate');
check(read('CLAUDE.md').includes('# 50. PROJECT AGENT SYSTEM'),
  'CLAUDE.md documents the project agent system');

if (failures.length > 0) {
  console.error(`FAIL — ${failures.length} issue(s), ${passes} checks passed`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`PASS — ${passes} structural checks`);
console.log(`${requiredAgents.length} agents, ${requiredCommands.length} commands, ${scenarios.length} scenarios`);
console.log('Live Claude Code evaluations: NOT RUN — use run-agent-evals.mjs with an authenticated CLI');
