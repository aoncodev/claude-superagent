import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeRepo, runCli } from './helpers.mjs';
import { activeRunId, loadEvents, loadRun, loadTickets, stateDir } from '../lib/state.mjs';

const sh = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};

function plan() {
  const t = (id, dir) => ({ id, title: id, kind: 'work', wave: 1, scope: `Build ${dir}`, owns: [`${dir}/`], reads: [], contracts: [], done_when: ['works'] });
  return {
    title: 'Two parts',
    charter: { idea: 'Two parts.', in_scope: ['a', 'b'], out_of_scope: [], allowed_actions: [] },
    project: { kind: 'existing', stack: null, setup: [], checks: ['true'], integration_checks: [] },
    contracts: [],
    tickets: [t('T1', 'a'), t('T2', 'b'), { ...t('T3', 'c'), wave: 2 }],
  };
}

const drafts = (root) => {
  const d = join(stateDir(root), 'drafts');
  mkdirSync(d, { recursive: true });
  return d;
};
const writeJson = (root, name, obj) => {
  const f = join(drafts(root), name);
  writeFileSync(f, JSON.stringify(obj));
  return f;
};

/** Approved run; T1 and T2 started, claimed in their own worktrees, each with one commit in its own territory. */
function setup({ commit = true } = {}) {
  const root = makeRepo();
  assert.equal(runCli(['init', '--title', 'Two parts'], { cwd: root }).code, 0);
  const id = activeRunId(root);
  assert.equal(runCli(['propose', writeJson(root, 'plan.json', plan())], { cwd: root }).code, 0);
  assert.equal(runCli(['approve'], { cwd: root }).code, 0);
  const wt = {};
  for (const [t, dir] of [['T1', 'a'], ['T2', 'b']]) {
    assert.equal(runCli(['start-ticket', t, '--agent', `ag-${t}`], { cwd: root }).code, 0);
    const path = join(root, '.claude', 'worktrees', `agent-${t}`);
    sh(root, ['worktree', 'add', '-q', '-b', `worktree-agent-${t}`, path]);
    wt[t] = path;
    assert.equal(runCli(['claim', t], { cwd: path }).code, 0);
    if (commit) commitIn(path, `${dir}/file.txt`, `${t}\n`);
  }
  return { root, id, wt };
}

function commitIn(cwd, rel, text) {
  mkdirSync(dirname(join(cwd, rel)), { recursive: true });
  writeFileSync(join(cwd, rel), text);
  sh(cwd, ['add', '-A']);
  sh(cwd, ['commit', '-q', '-m', `change ${rel}`]);
}

function report(root, t, wtPath, over = {}) {
  const f = writeJson(root, `${t}-report.json`, {
    status: 'ready', summary: 'Done.', changed_files: [], branch: `worktree-agent-${t}`,
    commits: [sh(wtPath, ['rev-parse', 'HEAD'])], checks: [{ command: 'true', passed: true }], handbacks: [], ...over,
  });
  const r = runCli(['report', t, '--file', f], { cwd: wtPath });
  assert.equal(r.code, 0, r.stderr);
}

const ticket = (root, id, t) => loadTickets(root, id).find((x) => x.id === t);
const events = (root, id, type) => loadEvents(root, id).filter((e) => e.type === type);

test('merge merges both tickets and marks them merged', () => {
  const { root, id, wt } = setup();
  report(root, 'T1', wt.T1);
  report(root, 'T2', wt.T2);
  for (const t of ['T1', 'T2']) {
    const r = runCli(['merge', t], { cwd: root });
    assert.equal(r.code, 0, r.stderr);
  }
  assert.equal(ticket(root, id, 'T1').status, 'merged');
  assert.equal(ticket(root, id, 'T2').status, 'merged');
  assert.equal(readFileSync(join(root, 'a/file.txt'), 'utf8'), 'T1\n');
  assert.equal(readFileSync(join(root, 'b/file.txt'), 'utf8'), 'T2\n');
  const run = loadRun(root, id);
  assert.equal(run.phase, 'running');
  assert.equal(run.merging_ticket, null);
  const merged = events(root, id, 'merged');
  assert.equal(merged.length, 2);
  assert.equal(merged[1].sha, sh(root, ['rev-parse', 'HEAD']));
  assert.equal(sh(root, ['rev-list', '--merges', '--count', 'HEAD']), '2');
  // the worker's worktree and branch are left alone
  assert.ok(existsSync(wt.T1));
  assert.equal(sh(root, ['branch', '--list', 'worktree-agent-T1']).includes('worktree-agent-T1'), true);
});

test('merge refuses a ticket that is not ready, and a dirty main tree', () => {
  const { root, id, wt } = setup();
  const r = runCli(['merge', 'T1'], { cwd: root });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /ready/);
  report(root, 'T1', wt.T1);
  writeFileSync(join(root, 'stray.txt'), 'x');
  const d = runCli(['merge', 'T1'], { cwd: root });
  assert.equal(d.code, 3);
  assert.match(d.stdout, /stray\.txt/);
  assert.equal(ticket(root, id, 'T1').status, 'ready');
  assert.equal(loadRun(root, id).phase, 'running');
});

test('merge refuses when the integration branch is not checked out', () => {
  const { root, id, wt } = setup();
  report(root, 'T1', wt.T1);
  sh(root, ['checkout', '-q', 'main']);
  const r = runCli(['merge', 'T1'], { cwd: root });
  assert.equal(r.code, 3);
  assert.match(r.stderr, new RegExp(loadRun(root, id).integration_branch));
});

test('merge refuses outside running/merging phase', () => {
  const { root, wt } = setup();
  report(root, 'T1', wt.T1);
  assert.equal(runCli(['phase', 'verifying'], { cwd: root }).code, 0);
  assert.equal(runCli(['merge', 'T1'], { cwd: root }).code, 3);
});

test('check-diff lists violating paths and exits 3; clean exits 0', () => {
  const { root, wt } = setup();
  assert.equal(runCli(['check-diff', 'T1'], { cwd: root }).code, 0);
  commitIn(wt.T1, 'b/x.txt', 'oops\n');
  const r = runCli(['check-diff', 'T1'], { cwd: root });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /b\/x\.txt/);
  assert.doesNotMatch(r.stdout, /a\/file\.txt/);
});

test('merge rejects a branch that touched a path outside owns', () => {
  const { root, id, wt } = setup();
  commitIn(wt.T1, 'b/x.txt', 'oops\n');
  report(root, 'T1', wt.T1);
  const before = sh(root, ['rev-parse', 'HEAD']);
  const r = runCli(['merge', 'T1'], { cwd: root });
  assert.equal(r.code, 3);
  assert.match(r.stdout + r.stderr, /b\/x\.txt/);
  assert.equal(ticket(root, id, 'T1').status, 'failed');
  assert.equal(sh(root, ['rev-parse', 'HEAD']), before);
  assert.equal(loadRun(root, id).phase, 'running');
  const hb = events(root, id, 'handback');
  assert.equal(hb.length, 1);
  assert.equal(hb[0].ticket, 'T1');
  assert.match(JSON.stringify(hb[0]), /b\/x\.txt/);
});

/** T1 and the integration branch both change a/file.txt after T1 branched. */
function conflictSetup() {
  const f = setup();
  report(f.root, 'T1', f.wt.T1);
  commitIn(f.root, 'a/file.txt', 'integration\n');
  return f;
}

test('merge stops on conflict with phase merging and exit 3', () => {
  const { root, id } = conflictSetup();
  const r = runCli(['merge', 'T1'], { cwd: root });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /a\/file\.txt/);
  const run = loadRun(root, id);
  assert.equal(run.phase, 'merging');
  assert.equal(run.merging_ticket, 'T1');
  assert.equal(ticket(root, id, 'T1').status, 'ready');
  assert.ok(existsSync(join(root, '.git', 'MERGE_HEAD')));
  // no second merge while one is in progress
  assert.equal(runCli(['merge', 'T2'], { cwd: root }).code, 3);
});

test('merge-continue refuses with unresolved conflicts, then succeeds after resolving', () => {
  const { root, id } = conflictSetup();
  runCli(['merge', 'T1'], { cwd: root });
  const early = runCli(['merge-continue'], { cwd: root });
  assert.equal(early.code, 3);
  assert.match(early.stdout + early.stderr, /a\/file\.txt/);
  assert.equal(loadRun(root, id).merging_ticket, 'T1');

  writeFileSync(join(root, 'a/file.txt'), 'resolved\n');
  sh(root, ['add', 'a/file.txt']);
  const r = runCli(['merge-continue'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(ticket(root, id, 'T1').status, 'merged');
  const run = loadRun(root, id);
  assert.equal(run.phase, 'running');
  assert.equal(run.merging_ticket, null);
  assert.equal(readFileSync(join(root, 'a/file.txt'), 'utf8'), 'resolved\n');
  assert.equal(events(root, id, 'merged').at(-1).sha, sh(root, ['rev-parse', 'HEAD']));
  assert.ok(!existsSync(join(root, '.git', 'MERGE_HEAD')));
});

test('merge-continue refuses when no merge is in progress', () => {
  const { root } = setup();
  const r = runCli(['merge-continue'], { cwd: root });
  assert.equal(r.code, 3);
});

test('next-wave is refused while a ticket is blocked', () => {
  const { root, id, wt } = setup();
  report(root, 'T1', wt.T1);
  const f = writeJson(root, 'blocked.json', {
    status: 'blocked', summary: 'Stuck.', changed_files: [], branch: 'worktree-agent-T2', commits: [], checks: [], handbacks: [],
    progress: 'Half done.', question: { text: 'Which way?' },
  });
  assert.equal(runCli(['report', 'T2', '--file', f], { cwd: wt.T2 }).code, 0);
  const r = runCli(['next-wave'], { cwd: root });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /T2/);
  assert.equal(loadRun(root, id).current_wave, 1);
});

test('next-wave advances to the next wave with planned tickets', () => {
  const { root, id, wt } = setup();
  report(root, 'T1', wt.T1);
  report(root, 'T2', wt.T2);
  for (const t of ['T1', 'T2']) assert.equal(runCli(['merge', t], { cwd: root }).code, 0);
  const r = runCli(['next-wave'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  const run = loadRun(root, id);
  assert.equal(run.current_wave, 2);
  assert.equal(run.phase, 'running');
});

test('next-wave with nothing planned sets phase verifying', () => {
  const { root, id, wt } = setup();
  report(root, 'T1', wt.T1);
  report(root, 'T2', wt.T2);
  for (const t of ['T1', 'T2']) runCli(['merge', t], { cwd: root });
  assert.equal(runCli(['next-wave'], { cwd: root }).code, 0); // to wave 2
  // drop the wave-2 ticket by hand
  const f = join(stateDir(root), 'runs', id, 'tickets', 'T3.json');
  const t3 = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, JSON.stringify({ ...t3, status: 'dropped' }));
  const r = runCli(['next-wave'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /none/);
  assert.equal(loadRun(root, id).phase, 'verifying');
});

test('next-wave requires phase running', () => {
  const { root } = setup();
  runCli(['phase', 'verifying'], { cwd: root });
  assert.equal(runCli(['next-wave'], { cwd: root }).code, 3);
});

test('verify-result passed moves to reviewing; failed stays in verifying', () => {
  const { root, id } = setup();
  assert.equal(runCli(['verify-result', '--passed', 'true'], { cwd: root }).code, 3, 'not verifying yet');
  runCli(['phase', 'verifying'], { cwd: root });
  assert.equal(runCli(['verify-result', '--passed', 'maybe'], { cwd: root }).code, 1);
  assert.equal(runCli(['verify-result'], { cwd: root }).code, 1);
  const log = join(drafts(root), 'v.log');
  writeFileSync(log, 'boom');
  assert.equal(runCli(['verify-result', '--passed', 'false', '--log', log], { cwd: root }).code, 0);
  assert.equal(loadRun(root, id).phase, 'verifying');
  const ev = events(root, id, 'verified');
  assert.equal(ev[0].passed, false);
  assert.equal(ev[0].log, log);
  assert.equal(runCli(['verify-result', '--passed', 'true'], { cwd: root }).code, 0);
  assert.equal(loadRun(root, id).phase, 'reviewing');
  assert.equal(events(root, id, 'verified')[1].passed, true);
});

test('review rejects a review missing extras', () => {
  const { root, id } = setup();
  runCli(['phase', 'reviewing'], { cwd: root });
  const bad = writeJson(root, 'review.json', { unmet: [], contradictions: [] });
  const r = runCli(['review', '--file', bad], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /extras/);
  assert.ok(!existsSync(join(stateDir(root), 'runs', id, 'reviews')));
  const bad2 = writeJson(root, 'review2.json', { unmet: [{ item: 'x' }], extras: [], contradictions: [] });
  assert.equal(runCli(['review', '--file', bad2], { cwd: root }).code, 1);
});

test('review writes reviews/<n>.json with increasing n and an event', () => {
  const { root, id } = setup();
  assert.equal(runCli(['review', '--file', writeJson(root, 'r.json', { unmet: [], extras: [], contradictions: [] })], { cwd: root }).code, 3, 'not reviewing yet');
  runCli(['phase', 'reviewing'], { cwd: root });
  const good = writeJson(root, 'r.json', { unmet: [{ item: 'login', evidence: 'no route' }], extras: [], contradictions: [] });
  assert.equal(runCli(['review', '--file', good], { cwd: root }).code, 0);
  assert.equal(runCli(['review', '--file', good], { cwd: root }).code, 0);
  const dir = join(stateDir(root), 'runs', id, 'reviews');
  assert.deepEqual(readdirSync(dir).sort(), ['1.json', '2.json']);
  assert.equal(JSON.parse(readFileSync(join(dir, '1.json'), 'utf8')).unmet[0].item, 'login');
  assert.equal(events(root, id, 'reviewed').length, 2);
});

test('finish is allowed from verifying or reviewing, sets done and clears active', () => {
  const { root, id } = setup();
  assert.equal(runCli(['finish'], { cwd: root }).code, 3, 'phase running');
  runCli(['phase', 'verifying'], { cwd: root });
  assert.equal(runCli(['finish'], { cwd: root }).code, 0);
  assert.equal(loadRun(root, id).phase, 'done');
  assert.equal(activeRunId(root), null);
  assert.equal(events(root, id, 'finished').length, 1);

  const b = setup();
  runCli(['phase', 'reviewing'], { cwd: b.root });
  assert.equal(runCli(['finish'], { cwd: b.root }).code, 0);
  assert.equal(loadRun(b.root, b.id).phase, 'done');
});

test('status prints the rendered status', () => {
  const { root, id } = setup();
  const r = runCli(['status'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').length, 2);
  assert.match(r.stdout, new RegExp(`Run ${id} · running · wave 1/2 · 2 running · 0 merged · 1 planned`));
  const j = runCli(['status', '--json'], { cwd: root });
  assert.equal(j.code, 0);
  assert.equal(JSON.parse(j.stdout).run.id, id);
});
