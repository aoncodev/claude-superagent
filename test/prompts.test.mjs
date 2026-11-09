import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Minimal frontmatter parser: `key: value` lines between the first two `---` lines. */
function frontmatter(rel) {
  const text = read(rel);
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, `${rel} must start with --- frontmatter ---`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2] };
}

// ---------------------------------------------------------------- agents

test('worker: frontmatter and required rules', () => {
  const { meta, body } = frontmatter('agents/worker.md');
  assert.equal(meta.name, 'worker');
  assert.ok(meta.description);
  assert.equal(meta.model, 'inherit');
  assert.equal(meta.tools, undefined, 'worker inherits all tools');
  for (const s of ['superagent claim', 'superagent brief', 'superagent report', 'handbacks', '100 words', 'exactly one']) {
    assert.ok(body.includes(s), `worker.md must mention ${s}`);
  }
  assert.ok(body.includes('Run every brief check.'), 'worker.md says "Run every brief check."');
  assert.ok(!/brief check that applies/.test(body));
});

test('worker: project context is read-only and never above the Charter', () => {
  const { body } = frontmatter('agents/worker.md');
  assert.ok(body.includes('## Project context'), 'worker.md documents the brief\'s project context section');
  assert.match(body, /read-only context/i);
  assert.match(body, /never above the Charter/i);
  assert.match(body, /never adds requirements/i);
});

test('worker: a common-rationalizations table names the scope traps', () => {
  const { body } = frontmatter('agents/worker.md');
  assert.ok(body.includes('## Common rationalizations'), 'worker.md needs a `## Common rationalizations` table');
  const rows = body.split('\n').filter((l) => /^\|\s*"/.test(l));
  assert.ok(rows.length >= 4, `the table needs at least four entries, found ${rows.length}`);
  for (const phrase of ['one tiny line', 'fix this other bug', 'check probably passes', 'widen the ticket']) {
    assert.match(body, new RegExp(phrase, 'i'), `the table must cover "${phrase}"`);
  }
});

test('fidelity-reviewer: frontmatter, met coverage and the review-worktree flow', () => {
  const { meta, body } = frontmatter('agents/fidelity-reviewer.md');
  assert.equal(meta.name, 'fidelity-reviewer');
  assert.ok(meta.description);
  assert.equal(meta.model, 'inherit');
  const tools = (meta.tools ?? '').split(',').map((s) => s.trim());
  for (const t of ['Read', 'Grep', 'Glob', 'Bash']) assert.ok(tools.includes(t), `reviewer needs the ${t} tool`);
  assert.ok(body.includes('met'), 'reviewer reports met items with evidence');
  assert.match(body, /review worktree/i, 'reviewer works in the review worktree');
  assert.ok(body.includes('superagent review-setup'), 'the reviewer names the command that prints its worktree');
  // Regression #6: read the run object only, never tickets or reports.
  assert.ok(body.includes('superagent show --run'), 'reviewer uses `superagent show --run`');
  assert.match(body, /never run `superagent show` with `--json`/i, 'reviewer is told never to run `show --json`');
});

test('plan-critic: read-only preflight agent returning risks as JSON', () => {
  const { meta, body } = frontmatter('agents/plan-critic.md');
  assert.equal(meta.name, 'plan-critic');
  assert.ok(meta.description, 'plan-critic.md needs a description');
  assert.equal(meta.model, 'inherit');
  assert.equal(meta.tools, 'Read, Grep, Glob, Bash', 'plan-critic is read-only');
  for (const s of ['risks', 'notes', 'coupling', 'shared_file', 'missing_contract', 'ambiguity', 'evidence', 'JSON']) {
    assert.ok(body.includes(s), `plan-critic.md must mention ${s}`);
  }
  assert.match(body, /read-only|never edit/i, 'plan-critic never edits files');
  assert.match(body, /do not read the tickets or the run state/i, 'plan-critic stays out of run state');
  assert.ok(!/\bWrite\b/.test(body), 'plan-critic must not use the Write tool');
});

// ---------------------------------------------------------------- orchestrate skill and commands

test('orchestrate skill: frontmatter, CLI commands and key rules', () => {
  const { meta, body } = frontmatter('skills/orchestrate/SKILL.md');
  assert.equal(meta.name, 'orchestrate');
  assert.ok(meta.description, 'SKILL.md needs a description');
  const commands = [
    'init', 'propose', 'approve', 'start-ticket', 'merge', 'merge-continue', 'answer', 'add-ticket',
    'next', 'next-wave', 'verify-result', 'review', 'review-setup', 'review-close', 'finish', 'status',
    'audit', 'ruling', 'context', 'show', 'set-agent', 'mark-failed',
  ];
  for (const c of commands) assert.ok(body.includes(`superagent ${c}`), `SKILL.md must mention \`superagent ${c}\``);
  for (const s of [
    'verbatim', 'isolation', 'superagent:worker', 'superagent:fidelity-reviewer', 'superagent:plan-critic',
    'SendMessage', 'AskUserQuestion', 'ListAgents', 'proposal-format.md', 'shared_files', 'depends_on',
    '`model`', '.superagent/drafts/<run-id>/context.md',
  ]) {
    assert.ok(body.includes(s), `SKILL.md must mention ${s}`);
  }
  assert.match(body, /plan preflight/i, 'SKILL.md has the plan preflight');
  assert.match(body, /fast path/i, 'SKILL.md has fast-path guidance');
  assert.match(body, /too small to beat one agent/i, 'the fast path is stated as the trade-off against one agent');
  assert.ok(!body.includes('superagent phase'), 'fix and fidelity waves re-enter through next-wave, not `superagent phase`');
  assert.ok(!/if the tool offers/i.test(body), 'background agents are stated flatly');
  assert.ok(body.split('\n').length <= 200, 'SKILL.md stays short');
});

test('orchestrate skill: next drives the loop, audit precedes verification and the reviewer is isolated', () => {
  const body = read('skills/orchestrate/SKILL.md');
  assert.match(body, /Do exactly that action, then call `next` again/i, 'the loop is next -> one action -> next');
  assert.ok(body.includes('superagent next'), 'the loop calls `superagent next`');
  assert.match(body, /ListAgents/, 'resume reconciles with ListAgents');
  assert.match(body, /running` tickets/, 'reconciliation compares ListAgents with running tickets');

  const audit = body.indexOf('superagent audit');
  const verifyResult = body.indexOf('superagent verify-result');
  assert.ok(audit >= 0 && verifyResult >= 0 && audit < verifyResult, 'audit runs before verification');

  const setup = body.indexOf('superagent review-setup');
  const launch = body.indexOf('subagent_type: "superagent:fidelity-reviewer"');
  const record = body.indexOf('superagent review --file');
  const close = body.indexOf('superagent review-close');
  assert.ok([setup, launch, record, close].every((i) => i >= 0), 'the reviewer worktree flow names every step');
  assert.ok(setup < launch && launch < record && record < close, 'order: review-setup, launch reviewer, review --file, review-close');
  assert.ok(body.includes('Review worktree:'), 'the reviewer prompt carries the worktree path');
});

test('orchestrate skill: launch order is start-ticket, Agent, set-agent, with the per-ticket model', () => {
  const body = read('skills/orchestrate/SKILL.md');
  const launch = body.slice(body.indexOf('**a. Launch.**'), body.indexOf('**b. '));
  const order = ['superagent start-ticket', 'Agent call', 'superagent set-agent'].map((s) => launch.indexOf(s));
  assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], 'launch order is start-ticket, Agent, set-agent');
  assert.match(launch, /model/, 'the Agent call takes the ticket model');
  assert.match(launch, /worker_model/, 'the Agent call falls back to the config worker model');
});

test('orchestrate skill: a repo created mid-session needs a restart before workers launch', () => {
  // E2E finding: Claude Code decides at session start whether the folder is a git repository, so
  // `isolation: "worktree"` fails with "Cannot create agent worktree" after `init --git-init`.
  const body = read('skills/orchestrate/SKILL.md');
  assert.ok(body.includes('Cannot create agent worktree'), 'SKILL.md must name the worktree-creation failure');
  assert.match(body, /--git-init[^\n]*\n(?:[^\n]*\n){0,3}[^\n]*restart/i, 'after --git-init the skill must say to restart the session');
  assert.ok(body.includes('/superagent:resume'), 'the restart path continues with /superagent:resume');
});

test('orchestrate skill: waiting for workers ends the turn without a progress message', () => {
  // E2E finding: the orchestrator ended each waiting turn with a progress line.
  const body = read('skills/orchestrate/SKILL.md');
  assert.match(body, /end your turn without a progress message/i);
});

test('slash commands: descriptions, arguments, no name collision with the skill', () => {
  for (const name of ['start', 'status', 'resume', 'abort']) {
    const { meta } = frontmatter(`commands/${name}.md`);
    assert.ok(meta.description, `commands/${name}.md needs a description`);
    assert.notEqual(name, 'orchestrate');
  }
  const start = frontmatter('commands/start.md');
  assert.ok(start.body.includes('$ARGUMENTS'), 'start.md must pass $ARGUMENTS');
  assert.ok(start.meta['argument-hint'], 'start.md needs an argument-hint');
  assert.ok(start.body.includes('superagent:orchestrate'), 'start.md must invoke the orchestrate skill');
  const resume = frontmatter('commands/resume.md');
  assert.ok(resume.body.includes('superagent:orchestrate'), 'resume.md must invoke the orchestrate skill');
  assert.ok(resume.body.includes('superagent context'), 'resume.md reads `superagent context` first');
  assert.ok(resume.body.indexOf('superagent context') < resume.body.indexOf('superagent:orchestrate'), 'resume reads context before the skill');
  assert.ok(frontmatter('commands/status.md').body.includes('superagent status'));
  assert.ok(frontmatter('commands/abort.md').body.includes('superagent abort'));
});

test('start command: "not a git repository" from status also means no active run', () => {
  // E2E finding: in an empty folder `superagent status` exits 1 (not a git repository), not 2.
  const body = read('commands/start.md');
  assert.match(body, /not (?:inside )?a git repository/i, 'start.md must treat "not a git repository" as no active run');
});

test('proposal-format.md: schema additions and the example plan passes validatePlan', async () => {
  const { validatePlan, ownsPath } = await import('../lib/plan.mjs');
  const text = read('skills/orchestrate/proposal-format.md');
  for (const s of ['shared_files', 'depends_on', 'model']) assert.ok(text.includes(s), `proposal-format.md must document ${s}`);

  const blocks = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  const example = blocks.map((b) => JSON.parse(b)).find((p) => p && Array.isArray(p.tickets) && p.charter);
  assert.ok(example, 'proposal-format.md must contain a complete Plan example in a ```json block');
  assert.deepEqual(validatePlan(example), []);

  // shared_files: no globs or duplicates, owned by a scaffold/contracts ticket, never by work/fix.
  assert.ok(Array.isArray(example.shared_files) && example.shared_files.length > 0, 'the example declares shared_files');
  assert.equal(new Set(example.shared_files).size, example.shared_files.length, 'shared_files has no duplicates');
  for (const f of example.shared_files) {
    assert.ok(!/[*?]/.test(f), `shared file ${f} must not be a glob`);
    assert.ok(example.tickets.some((t) => ['scaffold', 'contracts'].includes(t.kind) && ownsPath(t.owns, f)), `${f} is owned by a scaffold or contracts ticket`);
    assert.ok(!example.tickets.some((t) => ['work', 'fix'].includes(t.kind) && ownsPath(t.owns, f)), `${f} is not owned by a work or fix ticket`);
  }

  // depends_on and model
  const ids = new Set(example.tickets.map((t) => t.id));
  for (const t of example.tickets) {
    for (const d of t.depends_on ?? []) assert.ok(ids.has(d), `${t.id} depends_on unknown ticket ${d}`);
    if (t.depends_on) assert.equal(new Set(t.depends_on).size, t.depends_on.length, `${t.id} has a duplicate depends_on`);
    if (t.model !== undefined) assert.ok(typeof t.model === 'string' && t.model.trim() !== '', `${t.id}.model is a non-empty string`);
  }
  assert.ok(example.tickets.some((t) => Array.isArray(t.depends_on) && t.depends_on.length > 0), 'the example uses depends_on');
  assert.ok(example.tickets.some((t) => typeof t.model === 'string'), 'the example uses a per-ticket model');

  const shared = /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|pnpm-workspace\.yaml)$|^\.github\//;
  for (const t of example.tickets.filter((x) => x.kind === 'work' || x.kind === 'fix')) {
    for (const o of t.owns) assert.ok(!shared.test(o), `${t.id} is a work ticket but owns shared file ${o}`);
  }
  const kinds = new Set(example.tickets.map((t) => t.kind));
  assert.ok(kinds.has('contracts') && kinds.has('work'), 'example has contracts and work tickets');
  const waves = new Map();
  for (const t of example.tickets) waves.set(t.wave, (waves.get(t.wave) ?? 0) + 1);
  assert.ok([...waves.values()].filter((n) => n > 1).length >= 2, 'example has at least two parallel waves');
});

// ---------------------------------------------------------------- docs and versions

test('README documents the v0.2 commands, fields and honest limitations', () => {
  const readme = read('README.md');
  for (const c of ['doctor', 'audit', 'stats', 'next', 'review-setup', 'review-close', 'ruling', 'context']) {
    assert.ok(readme.includes(`\`${c}\``), `README must document \`${c}\``);
  }
  for (const s of ['shared_files', 'depends_on', '`model`', 'review worktree', 'met', 'human_interventions', 'evals/', 'plan-critic']) {
    assert.ok(readme.includes(s), `README must mention ${s}`);
  }
  assert.match(readme, /not sandboxed/i, 'README is honest that Bash is not sandboxed');
  assert.match(readme, /does not prevent/i, 'README says audit detects integrity violations without preventing them');
  assert.match(readme, /coupled to Claude Code/i, 'README states the platform coupling');
  assert.match(readme, /prompt-level/i, 'README says the reviewer Read-tool isolation is prompt-level');
});

test('regression #17: README states the diff-check gaps and how a fresh worker continues', () => {
  const readme = read('README.md');
  assert.match(readme, /git -C/, 'README names the `git -C <root> commit` bypass');
  assert.match(readme, /main checkout/i);
  assert.match(readme, /new worktree[^\n]*merges the earlier/i, 'a fresh worker gets a new worktree and merges the earlier branch');
});

test('package and plugin manifests are version 0.2.0 and require Node >= 22', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '0.2.0');
  assert.equal(pkg.engines?.node, '>=22');
  assert.equal(JSON.parse(read('.claude-plugin/plugin.json')).version, '0.2.0');
});

test('skill and commands name only commands the CLI has', async () => {
  const { execFileSync } = await import('node:child_process');
  let listed = '';
  try { execFileSync('node', [join(ROOT, 'bin', 'superagent.mjs')], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { listed = e.stderr; }
  const cli = new Set(listed.split('commands: ')[1].trim().split(', '));
  const files = [
    'skills/orchestrate/SKILL.md', 'skills/orchestrate/proposal-format.md', 'agents/worker.md',
    'agents/fidelity-reviewer.md', 'agents/plan-critic.md', 'commands/start.md', 'commands/status.md',
    'commands/resume.md', 'commands/abort.md', 'README.md', 'evals/README.md',
  ];
  for (const f of files) {
    for (const m of read(f).matchAll(/`superagent ([a-z][a-z-]+)/g)) {
      assert.ok(cli.has(m[1]), `${f} mentions \`superagent ${m[1]}\`, which the CLI does not have`);
    }
  }
});
