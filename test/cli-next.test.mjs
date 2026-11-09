import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeRepo, runCli, setPhase } from './helpers.mjs';
import { activeRunId, loadTickets, stateDir } from '../lib/state.mjs';

const sh = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};

const ticket = (id, dir, wave, extra = {}) => ({
  id, title: `Build ${dir}`, kind: 'work', wave, scope: `Build ${dir}`,
  owns: [`${dir}/`], reads: [], contracts: [], done_when: ['works'], ...extra,
});

function plan(over = {}) {
  return {
    title: 'Two parts',
    charter: { idea: 'Two parts.', in_scope: ['a', 'b'], out_of_scope: [], allowed_actions: [] },
    project: { kind: 'existing', stack: null, setup: [], checks: ['true'], integration_checks: [] },
    contracts: [],
    tickets: [ticket('T1', 'a', 1), ticket('T2', 'b', 1)],
    parallelism: 4,
    ...over,
  };
}

/** An approved run in a fresh repo. */
function setup(over = {}) {
  const root = makeRepo();
  assert.equal(runCli(['init', '--title', 'Two parts'], { cwd: root }).code, 0);
  const id = activeRunId(root);
  const drafts = join(stateDir(root), 'drafts');
  mkdirSync(drafts, { recursive: true });
  const path = join(drafts, 'plan.json');
  writeFileSync(path, JSON.stringify(plan(over)));
  assert.equal(runCli(['propose', path], { cwd: root }).code, 0);
  assert.equal(runCli(['approve'], { cwd: root }).code, 0);
  return { root, id };
}

function runNext(root) {
  const r = runCli(['next'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  return r.stdout.trim();
}

function runNextJson(root) {
  const r = runCli(['next', '--json'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

/** Start a ticket, claim it from a fresh worktree and commit one file under its owns; returns the worktree. */
function work(root, t, rel) {
  assert.equal(runCli(['start-ticket', t, '--agent', `ag-${t}`], { cwd: root }).code, 0);
  const wt = join(root, '.claude', 'worktrees', `agent-${t}`);
  sh(root, ['worktree', 'add', '-q', '-b', `worktree-agent-${t}`, wt]);
  assert.equal(runCli(['claim', t], { cwd: wt }).code, 0);
  const file = join(wt, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${t}\n`);
  sh(wt, ['add', '-A']);
  sh(wt, ['commit', '-q', '-m', `${t}: ${rel}`]);
  return wt;
}

function writeReport(root, name, report) {
  const file = join(stateDir(root), 'drafts', name);
  writeFileSync(file, JSON.stringify(report));
  return file;
}

function reportReady(root, t, wt, rel) {
  const file = writeReport(root, `${t}-ready.json`, {
    status: 'ready', summary: 'Done.', changed_files: [rel], branch: `worktree-agent-${t}`,
    commits: [sh(wt, ['rev-parse', 'HEAD'])], checks: [{ command: 'true', passed: true }], handbacks: [],
  });
  const r = runCli(['report', t, '--file', file], { cwd: wt });
  assert.equal(r.code, 0, r.stderr);
}

function reportBlocked(root, t) {
  const file = writeReport(root, `${t}-blocked.json`, {
    status: 'blocked', summary: 'Stuck.', changed_files: [], commits: [], handbacks: [],
    progress: 'Half done.', question: { text: `Which way for ${t}?`, options: ['A', 'B'] },
    checks: [],
  });
  const r = runCli(['report', t, '--file', file], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
}

/** Every file under .superagent/, to prove `next` writes nothing. */
function snapshot(root) {
  const dir = stateDir(root);
  const files = {};
  for (const rel of readdirSync(dir, { recursive: true }).sort()) {
    const path = join(dir, rel);
    if (statSync(path).isFile()) files[rel] = readFileSync(path, 'utf8');
  }
  return files;
}

const ticketStatus = (root, id, t) => loadTickets(root, id).find((x) => x.id === t).status;

test('closed phases and a phase without a defined action print none', () => {
  const { root } = setup();
  for (const phase of ['proposing', 'awaiting_approval', 'done', 'aborted', 'merging']) {
    setPhase(root, phase);
    assert.equal(runNext(root), 'none', phase);
    const json = runNextJson(root);
    assert.equal(json.action, 'none', phase);
    assert.deepEqual(json.tickets, [], phase);
  }
});

test('full flow: launch, wait, merge, advance, verify, review, none; next is read-only', () => {
  const { root, id } = setup();
  assert.equal(runNext(root), 'launch T1 T2');
  const launchJson = runNextJson(root);
  assert.equal(launchJson.action, 'launch');
  assert.deepEqual(launchJson.tickets, ['T1', 'T2']);
  assert.equal(typeof launchJson.detail, 'string');

  // `next` is read-only: no run/ticket/report/event byte changes.
  const before = snapshot(root);
  assert.equal(runNext(root), 'launch T1 T2');
  runNextJson(root);
  assert.deepEqual(snapshot(root), before, 'next must not write state');

  const wt1 = work(root, 'T1', 'a/file.txt');
  const wt2 = work(root, 'T2', 'b/file.txt');
  assert.equal(runNext(root), 'wait');

  reportReady(root, 'T1', wt1, 'a/file.txt');
  assert.equal(runNext(root), 'merge T1');
  assert.equal(runCli(['merge', 'T1'], { cwd: root }).code, 0);
  assert.equal(runNext(root), 'wait');

  reportReady(root, 'T2', wt2, 'b/file.txt');
  assert.equal(runNext(root), 'merge T2');
  assert.equal(runCli(['merge', 'T2'], { cwd: root }).code, 0);
  assert.equal(runNext(root), 'advance');

  assert.equal(runCli(['next-wave'], { cwd: root }).code, 0);
  assert.equal(runNext(root), 'verify');
  assert.equal(runCli(['verify-result', '--passed', 'true'], { cwd: root }).code, 0);
  assert.equal(runNext(root), 'review');
  assert.equal(ticketStatus(root, id, 'T1'), 'merged');

  setPhase(root, 'done');
  assert.equal(runNext(root), 'none');
  assert.deepEqual(runNextJson(root), { action: 'none', tickets: [], detail: 'phase done' });
});

test('launch respects parallelism and the free slots left by running tickets', () => {
  const { root } = setup({ parallelism: 1 });
  assert.equal(runNext(root), 'launch T1');
  const wt1 = work(root, 'T1', 'a/file.txt');
  assert.equal(runCli(['start-ticket', 'T2', '--agent', 'a2'], { cwd: root }).code, 0);
  reportReady(root, 'T1', wt1, 'a/file.txt');
  assert.equal(runNext(root), 'merge T1', 'no free slot while T2 is still running');
  assert.equal(runCli(['merge', 'T1'], { cwd: root }).code, 0);
  assert.equal(runNext(root), 'wait', 'T2 is running and T1 is merged');
});

test('a blocked ticket wins over verify and asks with the lowest numeric id', () => {
  const { root } = setup();
  assert.equal(runCli(['start-ticket', 'T1', '--agent', 'a1'], { cwd: root }).code, 0);
  assert.equal(runCli(['start-ticket', 'T2', '--agent', 'a2'], { cwd: root }).code, 0);
  reportBlocked(root, 'T2');
  reportBlocked(root, 'T1');
  assert.equal(runNext(root), 'ask T1');
  assert.deepEqual(runNextJson(root).tickets, ['T1']);
  assert.equal(runCli(['answer', 'T1', '--text', 'Use A.'], { cwd: root }).code, 0);
  assert.equal(runNext(root), 'ask T2');
  assert.equal(runCli(['answer', 'T2', '--text', 'Use B.'], { cwd: root }).code, 0);
  assert.equal(runNext(root), 'wait');
});

test('an interrupted merge makes next say merge-continue before anything else', () => {
  const { root } = setup();
  const wt1 = work(root, 'T1', 'a/file.txt');
  work(root, 'T2', 'b/file.txt');
  reportReady(root, 'T1', wt1, 'a/file.txt');
  mkdirSync(join(root, 'a'), { recursive: true });
  writeFileSync(join(root, 'a/file.txt'), 'integration\n');
  sh(root, ['add', 'a/file.txt']);
  sh(root, ['commit', '-q', '-m', 'integration change on a/file.txt']);

  assert.equal(runNext(root), 'merge T1');
  assert.equal(runCli(['merge', 'T1'], { cwd: root }).code, 3, 'the merge must conflict');
  assert.equal(runNext(root), 'merge-continue T1');
  assert.deepEqual(runNextJson(root), { action: 'merge-continue', tickets: ['T1'], detail: 'T1 is mid-merge' });
});

test('depends_on frontier: a later explicit-deps ticket launches although a lower-wave ticket is unmerged', () => {
  const { root, id } = setup({
    tickets: [
      ticket('T1', 'a', 1),
      ticket('T2', 'b', 1),
      ticket('T3', 'c', 2, { depends_on: ['T1'] }),
    ],
  });
  assert.equal(runNext(root), 'launch T1 T2');
  const wt1 = work(root, 'T1', 'a/file.txt');
  const wt2 = work(root, 'T2', 'b/file.txt');
  reportReady(root, 'T1', wt1, 'a/file.txt');
  reportReady(root, 'T2', wt2, 'b/file.txt');
  assert.equal(runCli(['merge', 'T1'], { cwd: root }).code, 0);
  assert.equal(ticketStatus(root, id, 'T2'), 'ready', 'the lower-wave ticket is still unmerged');
  assert.equal(ticketStatus(root, id, 'T3'), 'planned');
  assert.equal(runNext(root), 'launch T3', 'explicit depends_on ignores the lower-wave barrier');
  assert.deepEqual(runNextJson(root).tickets, ['T3']);
});

test('a failed ticket in a lower wave does not block later-wave launches (settled, like next-wave)', () => {
  const { root } = setup({
    tickets: [ticket('T1', 'a', 1), ticket('T2', 'b', 2)],
  });
  assert.equal(runNext(root), 'launch T1');
  assert.equal(runCli(['start-ticket', 'T1', '--agent', 'ag-T1'], { cwd: root }).code, 0);
  assert.equal(runCli(['mark-failed', 'T1', '--reason', 'the worker died twice'], { cwd: root }).code, 0);
  assert.equal(runNext(root), 'launch T2', 'a settled failed ticket must not deadlock the frontier');
  assert.equal(runCli(['start-ticket', 'T2'], { cwd: root }).code, 0, 'start-ticket agrees with next');
});
