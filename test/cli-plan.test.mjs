import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { makeRepo, runCli } from './helpers.mjs';
import { activeRunId, charterPath, loadRun, loadTickets, stateDir } from '../lib/state.mjs';

const IDEA = 'Логин sahifasi — add login\n\n# Not a heading? **bold** `code` <b>x</b>\n- bullet\n';

function plan(over = {}) {
  return {
    title: 'Login page',
    charter: { idea: IDEA, in_scope: ['login form'], out_of_scope: ['SSO'], allowed_actions: [] },
    project: { kind: 'existing', stack: null, setup: [], checks: ['npm test'], integration_checks: [] },
    contracts: [{ id: 'C1', title: 'Auth API', path: './docs/../docs/auth.md' }],
    tickets: [
      { id: 'T1', title: 'Contracts', kind: 'contracts', wave: 1, scope: 'Define auth API', owns: ['./docs/'], reads: ['src/../README.md'], contracts: [], done_when: ['doc exists'] },
      { id: 'T2', title: 'API', kind: 'work', wave: 2, scope: 'Build API', owns: ['src/api/'], reads: [], contracts: ['C1'], done_when: ['tests pass'] },
      { id: 'T3', title: 'UI', kind: 'work', wave: 2, scope: 'Build UI', owns: ['src/ui', 'web//index.html'], reads: [], contracts: ['C1'], done_when: ['renders'] },
    ],
    parallelism: 3,
    ...over,
  };
}

function setup(p = plan(), file = 'plan.json') {
  const root = makeRepo();
  assert.equal(runCli(['init', '--title', 'Login'], { cwd: root }).code, 0);
  const id = activeRunId(root);
  const drafts = join(stateDir(root), 'drafts');
  mkdirSync(drafts, { recursive: true });
  const path = join(drafts, file);
  writeFileSync(path, typeof p === 'string' ? p : JSON.stringify(p));
  return { root, id, path };
}

const runDirOf = (root, id) => join(stateDir(root), 'runs', id);

test('propose writes the charter verbatim', () => {
  const { root, id, path } = setup();
  const r = runCli(['propose', path], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  const text = readFileSync(join(runDirOf(root, id), 'charter.r1.md'), 'utf8');
  assert.ok(text.includes(`## Idea (verbatim)\n${IDEA}\n\n## In scope\n`));
  assert.ok(text.startsWith('# Charter r1 — Login page\n'));
  assert.match(text, /## Allowed outward actions\nnone — push, deploy, publish and production access are blocked\n$/);
  assert.ok(r.stdout.includes('Логин sahifasi — add login'));
  assert.match(r.stdout, /Wave 2 \(parallel\)/);
});

test('propose stores run fields, normalized tickets and contracts', () => {
  const { root, id, path } = setup();
  assert.equal(runCli(['propose', path], { cwd: root }).code, 0);
  const run = loadRun(root, id);
  assert.equal(run.phase, 'awaiting_approval');
  assert.equal(run.parallelism, 3);
  assert.deepEqual(run.allowed_actions, []);
  assert.equal(run.project.kind, 'existing');
  assert.equal(run.title, 'Login page');
  const tickets = loadTickets(root, id);
  assert.deepEqual(tickets.map((t) => t.id), ['T1', 'T2', 'T3']);
  assert.deepEqual(tickets[0].owns, ['docs/']);
  assert.deepEqual(tickets[0].reads, ['README.md']);
  assert.deepEqual(tickets[2].owns, ['src/ui', 'web/index.html']);
  assert.equal(tickets[0].status, 'planned');
  assert.equal(tickets[0].origin, 'plan');
  assert.equal(tickets[0].attempts, 0);
  assert.equal(tickets[0].answer, null);
  const contracts = JSON.parse(readFileSync(join(runDirOf(root, id), 'contracts.json'), 'utf8'));
  assert.deepEqual(contracts, [{ id: 'C1', title: 'Auth API', path: 'docs/auth.md' }]);
  assert.match(readFileSync(join(runDirOf(root, id), 'events.jsonl'), 'utf8'), /"type":"proposed"/);
});

test('propose with an invalid plan exits 1, prints every error, and leaves the phase as proposing', () => {
  const p = plan();
  p.charter.idea = '';
  p.tickets[1].owns = [];
  p.tickets[2].contracts = ['C9'];
  const { root, id, path } = setup(p);
  const r = runCli(['propose', path], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /charter\.idea/);
  assert.match(r.stderr, /T2.*owns/);
  assert.match(r.stderr, /T3.*C9/);
  assert.equal(loadRun(root, id).phase, 'proposing');
  assert.ok(!existsSync(join(runDirOf(root, id), 'charter.r1.md')));
  assert.deepEqual(loadTickets(root, id), []);
});

test('propose rejects unreadable or non-JSON plan files and a missing argument', () => {
  const { root, path } = setup('{ not json');
  assert.equal(runCli(['propose', path], { cwd: root }).code, 1);
  assert.equal(runCli(['propose', join(root, 'nope.json')], { cwd: root }).code, 1);
  assert.equal(runCli(['propose'], { cwd: root }).code, 1);
});

test('propose again before approval replaces the plan and drops stale tickets', () => {
  const { root, id, path } = setup();
  assert.equal(runCli(['propose', path], { cwd: root }).code, 0);
  const p2 = plan();
  p2.tickets = [p2.tickets[0]];
  p2.charter.idea = 'second idea';
  writeFileSync(path, JSON.stringify(p2));
  assert.equal(runCli(['propose', path], { cwd: root }).code, 0);
  assert.deepEqual(loadTickets(root, id).map((t) => t.id), ['T1']);
  assert.deepEqual(readdirSync(join(runDirOf(root, id), 'tickets')), ['T1.json']);
  assert.match(readFileSync(join(runDirOf(root, id), 'charter.r1.md'), 'utf8'), /second idea/);
});

test('proposal reprints exactly what propose printed', () => {
  const { root, path } = setup();
  const first = runCli(['propose', path], { cwd: root });
  const again = runCli(['proposal'], { cwd: root });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout, first.stdout);
});

test('proposal before propose exits 1', () => {
  const { root } = setup();
  assert.equal(runCli(['proposal'], { cwd: root }).code, 1);
});

test('propose then approve freezes the charter and sets current_wave to the lowest wave', () => {
  const { root, id, path } = setup();
  assert.equal(runCli(['propose', path], { cwd: root }).code, 0);
  const a = runCli(['approve'], { cwd: root });
  assert.equal(a.code, 0, a.stderr);
  const run = loadRun(root, id);
  assert.equal(run.phase, 'running');
  assert.equal(run.current_wave, 1);
  const bytes = readFileSync(charterPath(root, run), 'utf8');
  assert.equal(run.charter_sha256, createHash('sha256').update(bytes).digest('hex'));
});

test('propose after approval is refused', () => {
  const { root, path } = setup();
  runCli(['propose', path], { cwd: root });
  runCli(['approve'], { cwd: root });
  const r = runCli(['propose', path], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /revise-charter/);
});

test('revise-charter before approve exits 1', () => {
  const { root, path } = setup();
  runCli(['propose', path], { cwd: root });
  const file = join(dirname(path), 'idea2.txt');
  writeFileSync(file, 'new idea');
  const r = runCli(['revise-charter', file], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /approv/);
});

test('revise-charter after approve writes r2, keeps scope, and returns to awaiting_approval', () => {
  const p = plan();
  p.charter.in_scope = ['login form', 'password reset'];
  p.charter.allowed_actions = ['push'];
  const { root, id, path } = setup(p);
  runCli(['propose', path], { cwd: root });
  runCli(['approve'], { cwd: root });
  const r1 = readFileSync(join(runDirOf(root, id), 'charter.r1.md'), 'utf8');
  const newIdea = '  Новая идея — add login and 2FA\n\n## In scope\n- trailing newline kept\n';
  const file = join(dirname(path), 'idea2.txt');
  writeFileSync(file, newIdea);
  const r = runCli(['revise-charter', file], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  const run = loadRun(root, id);
  assert.equal(run.charter_rev, 2);
  assert.equal(run.charter_sha256, null);
  assert.equal(run.phase, 'awaiting_approval');
  const r2 = readFileSync(join(runDirOf(root, id), 'charter.r2.md'), 'utf8');
  assert.ok(r2.startsWith('# Charter r2 — Login page\n'));
  assert.ok(r2.includes(`## Idea (verbatim)\n${newIdea}\n\n## In scope\n- login form\n- password reset\n\n## Out of scope\n- SSO\n`));
  assert.match(r2, /## Allowed outward actions\npush — /);
  assert.equal(readFileSync(join(runDirOf(root, id), 'charter.r1.md'), 'utf8'), r1, 'r1 is untouched');
  assert.match(readFileSync(join(runDirOf(root, id), 'events.jsonl'), 'utf8'), /"type":"charter_revised"/);
});

test('propose, approve, revise-charter, approve keeps the branch and base and restores the phase', () => {
  const { root, id, path } = setup();
  runCli(['propose', path], { cwd: root });
  assert.equal(runCli(['approve'], { cwd: root }).code, 0);
  assert.equal(runCli(['phase', 'merging'], { cwd: root }).code, 0);
  const before = loadRun(root, id);
  const file = join(dirname(path), 'idea2.txt');
  writeFileSync(file, 'a revised idea');
  assert.equal(runCli(['revise-charter', file], { cwd: root }).code, 0);
  const r = runCli(['approve'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  const run = loadRun(root, id);
  assert.equal(run.base_sha, before.base_sha);
  assert.equal(run.base_branch, before.base_branch);
  assert.equal(run.integration_branch, before.integration_branch);
  assert.equal(run.current_wave, before.current_wave);
  assert.equal(run.phase, 'merging');
  assert.equal(run.charter_rev, 2);
  assert.equal(run.charter_sha256, createHash('sha256').update(readFileSync(charterPath(root, run), 'utf8')).digest('hex'));
  const events = readFileSync(join(runDirOf(root, id), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.filter((e) => e.type === 'approved').at(-1).rev, 2);
});

test('re-approve defaults the phase to running and needs the integration branch checked out', () => {
  const { root, id, path } = setup();
  runCli(['propose', path], { cwd: root });
  runCli(['approve'], { cwd: root });
  const file = join(dirname(path), 'idea2.txt');
  writeFileSync(file, 'a revised idea');
  runCli(['revise-charter', file], { cwd: root });
  spawnSync('git', ['checkout', '-q', 'main'], { cwd: root });
  const refused = runCli(['approve'], { cwd: root });
  assert.equal(refused.code, 3);
  assert.match(refused.stderr, new RegExp(`superagent/${id}`));
  assert.equal(loadRun(root, id).phase, 'awaiting_approval');
  spawnSync('git', ['checkout', '-q', `superagent/${id}`], { cwd: root });
  assert.equal(runCli(['approve'], { cwd: root }).code, 0);
  assert.equal(loadRun(root, id).phase, 'running');
});

test('revise-charter rejects a missing or empty file', () => {
  const { root, path } = setup();
  runCli(['propose', path], { cwd: root });
  runCli(['approve'], { cwd: root });
  assert.equal(runCli(['revise-charter', join(root, 'nope.txt')], { cwd: root }).code, 1);
  const empty = join(dirname(path), 'empty.txt');
  writeFileSync(empty, '');
  assert.equal(runCli(['revise-charter', empty], { cwd: root }).code, 1);
  assert.equal(runCli(['revise-charter'], { cwd: root }).code, 1);
});

test('revise-charter on a finished run is refused', () => {
  const { root, path } = setup();
  runCli(['propose', path], { cwd: root });
  runCli(['approve'], { cwd: root });
  runCli(['abort'], { cwd: root });
  const file = join(dirname(path), 'idea2.txt');
  writeFileSync(file, 'new idea');
  const r = runCli(['revise-charter', file, '--run', loadRunId(root)], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cannot revise: run .* is aborted/);
});

function loadRunId(root) {
  return readdirSync(join(stateDir(root), 'runs'))[0];
}
