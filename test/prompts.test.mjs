import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'agents');

/** Minimal frontmatter parser: `key: value` lines between the first two `---` lines. */
function parse(file) {
  const text = readFileSync(join(AGENTS, file), 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, `${file} must start with --- frontmatter ---`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2] };
}

test('worker: frontmatter and required rules', () => {
  const { meta, body } = parse('worker.md');
  assert.equal(meta.name, 'worker');
  assert.ok(meta.description);
  assert.equal(meta.model, 'inherit');
  assert.equal(meta.tools, undefined, 'worker inherits all tools');
  for (const s of ['superagent claim', 'superagent brief', 'superagent report', 'handbacks', '100 words', 'exactly one']) {
    assert.ok(body.includes(s), `worker.md must mention ${s}`);
  }
});

test('fidelity-reviewer: frontmatter and required rules', () => {
  const { meta, body } = parse('fidelity-reviewer.md');
  assert.equal(meta.name, 'fidelity-reviewer');
  assert.ok(meta.description);
  assert.equal(meta.model, 'inherit');
  assert.equal(meta.tools, 'Read, Grep, Glob, Bash, Write');
  for (const s of ['superagent review', 'must not read the tickets']) {
    assert.ok(body.includes(s), `fidelity-reviewer.md must mention ${s}`);
  }
});

// ---------------------------------------------------------------- orchestrator skill and commands

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

function frontmatter(rel) {
  const m = read(rel).match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, `${rel} must start with --- frontmatter ---`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2] };
}

test('orchestrate skill: frontmatter, CLI commands and key rules', () => {
  const { meta, body } = frontmatter('skills/orchestrate/SKILL.md');
  assert.equal(meta.name, 'orchestrate');
  assert.ok(meta.description, 'SKILL.md needs a description');
  const commands = ['init', 'propose', 'approve', 'start-ticket', 'merge', 'answer', 'add-ticket', 'next-wave', 'verify-result', 'review', 'finish', 'status'];
  for (const c of commands) assert.ok(body.includes(`superagent ${c}`), `SKILL.md must mention \`superagent ${c}\``);
  for (const s of ['verbatim', 'isolation', 'superagent:worker', 'superagent:fidelity-reviewer', 'SendMessage', 'AskUserQuestion', 'ListAgents', 'proposal-format.md']) {
    assert.ok(body.includes(s), `SKILL.md must mention ${s}`);
  }
  for (const c of ['set-agent', 'mark-failed', 'merge-continue']) assert.ok(body.includes(`superagent ${c}`), `SKILL.md must mention \`superagent ${c}\``);
  assert.ok(!body.includes('superagent phase'), 'fix and fidelity waves re-enter through next-wave, not `superagent phase`');
  assert.ok(!/if the tool offers/i.test(body), 'background agents are stated flatly');
  const launch = body.slice(body.indexOf('**a. Launch.**'), body.indexOf('**b. '));
  const order = ['superagent start-ticket', 'Agent call', 'superagent set-agent'].map((s) => launch.indexOf(s));
  assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], 'launch order is start-ticket, Agent, set-agent');
  assert.ok(body.split('\n').length <= 160, 'SKILL.md stays short');
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
  assert.ok(frontmatter('commands/resume.md').body.includes('superagent:orchestrate'), 'resume.md must invoke the orchestrate skill');
  assert.ok(frontmatter('commands/status.md').body.includes('superagent status'));
  assert.ok(frontmatter('commands/abort.md').body.includes('superagent abort'));
});

test('proposal-format.md: the example plan passes validatePlan', async () => {
  const { validatePlan } = await import('../lib/plan.mjs');
  const text = read('skills/orchestrate/proposal-format.md');
  const blocks = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  const example = blocks.map((b) => JSON.parse(b)).find((p) => p && Array.isArray(p.tickets) && p.charter);
  assert.ok(example, 'proposal-format.md must contain a complete Plan example in a ```json block');
  assert.deepEqual(validatePlan(example), []);
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

test('orchestrate skill: a repo created mid-session needs a restart before workers launch', () => {
  // E2E finding: Claude Code decides at session start whether the folder is a git repository, so
  // `isolation: "worktree"` fails with "Cannot create agent worktree" after `init --git-init`.
  const body = read('skills/orchestrate/SKILL.md');
  assert.ok(body.includes('Cannot create agent worktree'), 'SKILL.md must name the worktree-creation failure');
  assert.match(body, /--git-init[^\n]*\n(?:[^\n]*\n){0,3}[^\n]*restart/i, 'after --git-init the skill must say to restart the session');
  assert.ok(body.includes('/superagent:resume'), 'the restart path continues with /superagent:resume');
});

test('start command: "not a git repository" from status also means no active run', () => {
  // E2E finding: in an empty folder `superagent status` exits 1 (not a git repository), not 2.
  const body = read('commands/start.md');
  assert.match(body, /not (?:inside )?a git repository/i, 'start.md must treat "not a git repository" as no active run');
});

test('orchestrate skill: waiting for workers ends the turn without a progress message', () => {
  // E2E finding: the orchestrator ended each waiting turn with a progress line ("T3 is done. Wave 2 is still waiting...").
  const body = read('skills/orchestrate/SKILL.md');
  assert.match(body, /end your turn without a progress message/i);
});
