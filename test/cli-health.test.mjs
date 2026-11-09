import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, runCli, setPhase } from './helpers.mjs';
import { runDoctor } from '../lib/commands/health.mjs';
import {
  activeRunId, appendEvent, charterPath, loadEvents, loadRun, saveRun, saveTicket, stateDir,
} from '../lib/state.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const sh = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

const emptyDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'superagent-health-')));

function initRun(root, title = 'My Task') {
  const r = runCli(['init', '--title', title], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  return activeRunId(root);
}

/** init + a charter + approve: the run now has base_branch/base_sha/integration_branch. */
function approvedRun(root) {
  const id = initRun(root);
  writeFileSync(charterPath(root, loadRun(root, id)), '# Charter\n\nBuild it.\n');
  setPhase(root, 'awaiting_approval');
  const r = runCli(['approve'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  return id;
}

/**
 * A branch off the integration branch with one commit in `dir`, plus a ready ticket pointing at it, so
 * `superagent merge` creates a real merge commit. Leaves the main checkout on the integration branch.
 */
function readyTicket(root, id, { ticketId = 'T1', dir = 'a', branch = 'worktree-agent-T1' } = {}) {
  const run = loadRun(root, id);
  sh(root, ['checkout', '-q', '-b', branch]);
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'file.txt'), `${ticketId}\n`);
  sh(root, ['add', '.']);
  sh(root, ['commit', '-q', '-m', `${ticketId}: work`]);
  sh(root, ['checkout', '-q', run.integration_branch]);
  saveTicket(root, id, {
    id: ticketId, title: ticketId, kind: 'work', wave: 1, scope: `Build ${dir}`, owns: [`${dir}/`],
    reads: [], contracts: [], depends_on: [], done_when: ['works'],
    status: 'ready', origin: 'plan', agent_id: `ag-${ticketId}`, worktree: null, branch, attempts: 0, answer: null,
  });
}

test('doctor passes in a temp git repo and only warns about missing state', () => {
  const root = makeRepo();
  const r = runCli(['doctor'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^ok: node >= 22 /m);
  assert.match(r.stdout, /^ok: plugin layout /m);
  assert.match(r.stdout, /^ok: hooks\.json registrations$/m);
  assert.match(r.stdout, /^ok: git repository /m);
  assert.match(r.stdout, /^warn: no active run$/m);
  assert.doesNotMatch(r.stdout, /^FAIL:/m);
  assert.match(r.stdout, /^doctor: all checks passed$/m);
  assert.equal(r.stderr, '');
});

test('runDoctor FAILs when an injected pluginRoot is missing a guard file', () => {
  const cwd = makeRepo();
  const pluginRoot = emptyDir();
  mkdirSync(join(pluginRoot, 'hooks'));
  writeFileSync(join(pluginRoot, 'hooks', 'hooks.json'), readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  writeFileSync(join(pluginRoot, 'hooks', 'guard-bash.mjs'), '// stub\n');
  const res = runDoctor({ pluginRoot, cwd });
  assert.equal(res.ok, false);
  assert.ok(res.lines.some((l) => /^FAIL: plugin layout: .*hooks\/guard-files\.mjs/.test(l)), res.lines.join('\n'));
  assert.ok(res.lines.some((l) => /^FAIL: hooks\.json registrations/.test(l)), res.lines.join('\n'));
});

test('runDoctor decision self-tests deny run-state writes and git push, and allow git status', () => {
  const res = runDoctor({ cwd: makeRepo() });
  const text = res.lines.join('\n');
  assert.match(text, /^ok: guard denies writes to run state$/m);
  assert.match(text, /^ok: guard denies git push for a guarded run$/m);
  assert.match(text, /^ok: guard allows git status$/m);
  assert.equal(res.ok, true);
});

test('audit ok on a clean approved run and appends an audited event', () => {
  const root = makeRepo();
  const id = approvedRun(root);
  const r = runCli(['audit'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^audit ok$/m);
  assert.doesNotMatch(r.stdout, /^warn:/m);
  assert.doesNotMatch(r.stdout, /FAIL/);
  const audited = loadEvents(root, id).at(-1);
  assert.equal(audited.type, 'audited');
  assert.equal(audited.ok, true);
  assert.deepEqual(audited.checks, [
    { name: 'base tip', ok: true },
    { name: 'integration commits', ok: true },
    { name: 'clean tree', ok: true },
    { name: 'guard self-tests', ok: true },
  ]);
});

test('audit warns, but still passes, off the integration branch', () => {
  const root = makeRepo();
  const id = approvedRun(root);
  sh(root, ['checkout', '-q', 'main']);
  const r = runCli(['audit'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^warn: main checkout is on main, expected superagent\//m);
  assert.match(r.stdout, /^audit ok$/m);
  assert.equal(loadEvents(root, id).at(-1).ok, true);
});

test('audit exits 3 on a dirty working tree and records the failed clean tree check', () => {
  const root = makeRepo();
  const id = approvedRun(root);
  writeFileSync(join(root, 'dirty.txt'), 'not committed\n');
  const r = runCli(['audit'], { cwd: root });
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stdout, /^audit FAILED$/m);
  assert.match(r.stdout, /^FAIL: clean tree: 1 uncommitted change: dirty\.txt$/m);
  assert.doesNotMatch(r.stdout, /^warn:/m);
  const audited = loadEvents(root, id).at(-1);
  assert.equal(audited.type, 'audited');
  assert.equal(audited.ok, false);
  assert.equal(audited.checks.find((c) => c.name === 'base tip').ok, true);
  assert.equal(audited.checks.find((c) => c.name === 'integration commits').ok, true);
  const clean = audited.checks.find((c) => c.name === 'clean tree');
  assert.equal(clean.ok, false);
  assert.match(clean.detail, /dirty\.txt/);
});

test('audit exits 3 when the base branch moved and prints the offending commit', () => {
  const root = makeRepo();
  const id = approvedRun(root);
  const wt = join(mkdtempSync(join(tmpdir(), 'superagent-wt-')), 'base');
  sh(root, ['worktree', 'add', '-q', wt, 'main']);
  writeFileSync(join(wt, 'off-base.txt'), 'changed\n');
  sh(wt, ['add', '.']);
  sh(wt, ['commit', '-q', '-m', 'change base after approval']);
  sh(root, ['worktree', 'remove', '--force', wt]);
  const moved = sh(root, ['rev-parse', '--short', 'main']);

  const r = runCli(['audit'], { cwd: root });
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stdout, /^audit FAILED$/m);
  assert.match(r.stdout, /^FAIL: base tip:/m);
  assert.match(r.stdout, /change base after approval/);
  assert.ok(r.stdout.includes(moved), r.stdout);
  assert.match(r.stdout, /base branch moved/i);

  const audited = loadEvents(root, id).at(-1);
  assert.equal(audited.type, 'audited');
  assert.equal(audited.ok, false);
  const base = audited.checks.find((c) => c.name === 'base tip');
  assert.equal(base.ok, false);
  assert.match(base.detail, /change base after approval/);
});

test('audit passes a clean run whose integration branch holds only recorded merges', () => {
  const root = makeRepo();
  const id = approvedRun(root);
  readyTicket(root, id, { ticketId: 'T1', dir: 'a', branch: 'worktree-agent-T1' });
  readyTicket(root, id, { ticketId: 'T2', dir: 'b', branch: 'worktree-agent-T2' });
  for (const t of ['T1', 'T2']) {
    const r = runCli(['merge', t], { cwd: root });
    assert.equal(r.code, 0, r.stderr);
  }
  const run = loadRun(root, id);
  const recorded = loadEvents(root, id).filter((e) => e.type === 'merged').map((e) => e.sha);
  assert.equal(recorded.length, 2);
  const firstParent = sh(root, ['rev-list', '--first-parent', `${run.base_sha}..${run.integration_branch}`]).split('\n');
  assert.deepEqual([...firstParent].sort(), [...recorded].sort());

  const r = runCli(['audit'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^audit ok$/m);
  assert.doesNotMatch(r.stdout, /FAIL/);
  const audited = loadEvents(root, id).at(-1);
  assert.equal(audited.type, 'audited');
  assert.equal(audited.ok, true);
  assert.equal(audited.checks.find((c) => c.name === 'integration commits').ok, true);
  assert.equal(audited.checks.find((c) => c.name === 'clean tree').ok, true);
});

test('audit exits 3 and names a rogue commit made in the main checkout on the integration branch', () => {
  const root = makeRepo();
  const id = approvedRun(root);
  readyTicket(root, id); // T1, its worktree-agent-T1 branch, one commit
  const merged = runCli(['merge', 'T1'], { cwd: root });
  assert.equal(merged.code, 0, merged.stderr);

  // A commit outside any ticket: made directly on the integration branch in the main checkout.
  writeFileSync(join(root, 'rogue.txt'), 'outside any ticket\n');
  sh(root, ['add', 'rogue.txt']);
  sh(root, ['commit', '-q', '-m', 'rogue commit made in the main checkout']);
  const rogueOneline = sh(root, ['log', '--oneline', '-1', 'HEAD']);

  const r = runCli(['audit'], { cwd: root });
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stdout, /^audit FAILED$/m);
  assert.match(r.stdout, /^FAIL: integration commits: /m);
  assert.ok(r.stdout.includes(rogueOneline), r.stdout);
  assert.match(r.stdout, /A commit outside any ticket was made in the main checkout/);
  assert.match(r.stdout, /remove them from the integration branch/);

  const audited = loadEvents(root, id).at(-1);
  assert.equal(audited.type, 'audited');
  assert.equal(audited.ok, false);
  assert.equal(audited.checks.find((c) => c.name === 'base tip').ok, true);
  assert.equal(audited.checks.find((c) => c.name === 'clean tree').ok, true);
  const check = audited.checks.find((c) => c.name === 'integration commits');
  assert.equal(check.ok, false);
  assert.match(check.detail, /rogue commit made in the main checkout/);
  assert.ok(check.detail.includes(rogueOneline), check.detail);
  const mergedSha = loadEvents(root, id).find((e) => e.type === 'merged').sha;
  const mergedOneline = sh(root, ['log', '--oneline', '-1', mergedSha]);
  assert.ok(!check.detail.includes(mergedOneline), 'the recorded merge is not reported');
});

test('audit on a run whose integration branch no longer resolves is a state error (exit 2)', () => {
  const root = makeRepo();
  const id = approvedRun(root);
  const run = loadRun(root, id);
  sh(root, ['checkout', '-q', 'main']);
  sh(root, ['branch', '-D', run.integration_branch]);
  const r = runCli(['audit'], { cwd: root });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /cannot read the integration branch/);
  assert.doesNotMatch(r.stdout, /audit ok/);
});

test('audit outside a git repository warns and exits 2', () => {
  const r = runCli(['audit'], { cwd: emptyDir() });
  assert.equal(r.code, 2);
  assert.match(r.stdout, /^warn: not inside a git repository/m);
  assert.doesNotMatch(r.stdout, /audit ok/);
});

test('audit on a run with no integration branch is a state error (exit 2)', () => {
  const root = makeRepo();
  initRun(root);
  const r = runCli(['audit'], { cwd: root });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no integration branch/);
});

test('stats --json prints every metric on a fixture run', () => {
  const root = makeRepo();
  const id = initRun(root, 'Metrics');
  const run = loadRun(root, id);
  run.phase = 'done';
  run.current_wave = 2;
  run.parallelism = 3;
  run.created_at = new Date(Date.now() - 125_000).toISOString();
  run.fix_waves_used = { fix: 1, fidelity: 0 };
  saveRun(root, run);
  const ticket = (tid, wave, status, attempts) => ({
    id: tid, title: tid, kind: 'work', wave, status, origin: 'plan', attempts,
  });
  saveTicket(root, id, ticket('T1', 1, 'merged', 2));
  saveTicket(root, id, ticket('T2', 1, 'planned', 1));
  saveTicket(root, id, ticket('T3', 2, 'blocked', 0));
  appendEvent(root, id, 'ticket_reported', { ticket: 'T1', attempt: 1, status: 'blocked' });
  appendEvent(root, id, 'ticket_reported', { ticket: 'T2', attempt: 1, status: 'ready' });
  appendEvent(root, id, 'merge_conflict', { ticket: 'T1', files: ['a.txt'] });
  appendEvent(root, id, 'merged', { ticket: 'T1', sha: 'abc' });
  appendEvent(root, id, 'verified', { passed: true });
  appendEvent(root, id, 'reviewed', { n: 1 });
  appendEvent(root, id, 'finished', { from: 'reviewing' });

  const r = runCli(['stats', '--json'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.equal(data.id, id);
  assert.equal(data.title, 'Metrics');
  assert.equal(data.phase, 'done');
  assert.equal(data.wave, 2);
  assert.equal(data.parallelism, 3);
  assert.equal(data.created_at, run.created_at);
  assert.ok(!Number.isNaN(Date.parse(data.finished_at)));
  assert.ok(data.duration_seconds >= 120 && data.duration_seconds <= 140, String(data.duration_seconds));
  assert.equal(data.tickets_total, 3);
  assert.deepEqual(data.tickets_by_status, { merged: 1, planned: 1, blocked: 1 });
  assert.deepEqual(data.tickets_by_origin, { plan: 3 });
  assert.equal(data.attempts, 3);
  assert.equal(data.blocked_events, 1);
  assert.equal(data.merge_conflicts, 1);
  assert.equal(data.merges, 1);
  assert.equal(data.verifications, 1);
  assert.equal(data.reviews, 1);
  assert.deepEqual(data.fix_waves_used, { fix: 1, fidelity: 0 });
  assert.equal(data.events_total, loadEvents(root, id).length);
  assert.equal(data.events_total, 8);

  const human = runCli(['stats'], { cwd: root });
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, new RegExp(`^run:\\s+${id}$`, 'm'));
  assert.match(human.stdout, /^tickets:\s+3 \(/m);
  assert.match(human.stdout, /^fix waves:\s+fix 1, fidelity 0$/m);
});

test('stats exits 2 when events.jsonl is corrupt', () => {
  const root = makeRepo();
  const id = initRun(root);
  appendFileSync(join(stateDir(root), 'runs', id, 'events.jsonl'), '{oops\n');
  const r = runCli(['stats', '--json'], { cwd: root });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /events\.jsonl/);
});
