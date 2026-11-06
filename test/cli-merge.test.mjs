import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeRepo, runCli, setPhase } from './helpers.mjs';
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
  setPhase(root, 'verifying');
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
  assert.equal(runCli(['merge', 'T1'], { cwd: root }).code, 0);
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

test('next-wave is refused while a ticket is ready but unmerged, naming it', () => {
  const { root, id, wt } = setup();
  report(root, 'T1', wt.T1);
  report(root, 'T2', wt.T2);
  assert.equal(runCli(['merge', 'T1'], { cwd: root }).code, 0);
  const r = runCli(['next-wave'], { cwd: root });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /T2/);
  assert.doesNotMatch(r.stderr, /T1/);
  assert.match(r.stderr, /merge/);
  assert.equal(loadRun(root, id).current_wave, 1);
  assert.equal(runCli(['merge', 'T2'], { cwd: root }).code, 0);
  assert.equal(runCli(['next-wave'], { cwd: root }).code, 0);
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

test('next-wave requires phase running, or verifying/reviewing with planned tickets', () => {
  const { root } = setup();
  setPhase(root, 'merging');
  assert.equal(runCli(['next-wave'], { cwd: root }).code, 3);
  setPhase(root, 'awaiting_approval');
  assert.equal(runCli(['next-wave'], { cwd: root }).code, 3);
});

/** Wave 1 merged, wave 2's T3 left planned, run moved to `phase`. */
function afterLastWave(phase) {
  const { root, id, wt } = setup();
  report(root, 'T1', wt.T1);
  report(root, 'T2', wt.T2);
  for (const t of ['T1', 'T2']) assert.equal(runCli(['merge', t], { cwd: root }).code, 0);
  setPhase(root, phase);
  return { root, id };
}

for (const phase of ['verifying', 'reviewing']) {
  test(`next-wave from ${phase} with planned tickets re-enters running at the lowest planned wave`, () => {
    const { root, id } = afterLastWave(phase);
    const r = runCli(['next-wave'], { cwd: root });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /wave 2/);
    const run = loadRun(root, id);
    assert.equal(run.phase, 'running');
    assert.equal(run.current_wave, 2);
    assert.equal(runCli(['start-ticket', 'T3'], { cwd: root }).code, 0);
    assert.ok(events(root, id, 'phase').some((e) => e.from === phase && e.to === 'running'));
  });
}

test('next-wave from verifying or reviewing with nothing planned is refused', () => {
  const { root, id } = afterLastWave('reviewing');
  const f = join(stateDir(root), 'runs', id, 'tickets', 'T3.json');
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), status: 'dropped' }));
  const r = runCli(['next-wave'], { cwd: root });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /no ticket is planned/);
  assert.equal(loadRun(root, id).phase, 'reviewing');
  setPhase(root, 'verifying');
  assert.equal(runCli(['next-wave'], { cwd: root }).code, 3);
});

test('verify-result passed moves to reviewing; failed stays in verifying', () => {
  const { root, id } = setup();
  assert.equal(runCli(['verify-result', '--passed', 'true'], { cwd: root }).code, 3, 'not verifying yet');
  setPhase(root, 'verifying');
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
  setPhase(root, 'reviewing');
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
  setPhase(root, 'reviewing');
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
  setPhase(root, 'verifying');
  assert.equal(runCli(['verify-result', '--passed', 'false'], { cwd: root }).code, 0);
  assert.equal(runCli(['finish'], { cwd: root }).code, 0);
  assert.equal(loadRun(root, id).phase, 'done');
  assert.equal(activeRunId(root), null);
  assert.equal(events(root, id, 'finished').length, 1);

  const b = setup();
  setPhase(b.root, 'verifying');
  assert.equal(runCli(['verify-result', '--passed', 'true'], { cwd: b.root }).code, 0);
  assert.equal(runCli(['review', '--file', writeJson(b.root, 'rv.json', { unmet: [], extras: [], contradictions: [] })], { cwd: b.root }).code, 0);
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

// ---- final review: merge integrity ----

test('regression #1: merge-continue after a manual `git merge --abort` refuses; nothing is marked merged', () => {
  const { root, id } = conflictSetup();
  assert.equal(runCli(['merge', 'T1'], { cwd: root }).code, 3);
  sh(root, ['merge', '--abort']);
  const r = runCli(['merge-continue'], { cwd: root });
  assert.equal(r.code, 3, r.stdout);
  assert.match(r.stderr, /not merged|merge-abort/);
  assert.equal(ticket(root, id, 'T1').status, 'ready');
  assert.equal(loadRun(root, id).merging_ticket, 'T1');
  assert.equal(events(root, id, 'merged').length, 0);
});

test('regression #1: merge-continue refuses staged files that still hold conflict markers', () => {
  const { root, id } = conflictSetup();
  runCli(['merge', 'T1'], { cwd: root });
  sh(root, ['add', 'a/file.txt']); // staged with <<<<<<< markers still in it
  const r = runCli(['merge-continue'], { cwd: root });
  assert.equal(r.code, 3);
  assert.match(r.stdout + r.stderr, /conflict marker/);
  assert.match(r.stdout + r.stderr, /a\/file\.txt/);
  assert.ok(existsSync(join(root, '.git', 'MERGE_HEAD')), 'the merge is left in progress');
  assert.equal(ticket(root, id, 'T1').status, 'ready');
});

test('merge-continue accepts a merge the user already committed by hand', () => {
  const { root, id } = conflictSetup();
  runCli(['merge', 'T1'], { cwd: root });
  writeFileSync(join(root, 'a/file.txt'), 'resolved\n');
  sh(root, ['add', 'a/file.txt']);
  sh(root, ['commit', '-q', '--no-edit']);
  const r = runCli(['merge-continue'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(ticket(root, id, 'T1').status, 'merged');
});

test('regression #1: merge-abort <T> aborts the merge, fails the ticket, records a handback and returns to running', () => {
  const { root, id } = conflictSetup();
  const before = sh(root, ['rev-parse', 'HEAD']);
  assert.equal(runCli(['merge-abort', 'T1'], { cwd: root }).code, 3, 'no merge in progress yet');
  runCli(['merge', 'T1'], { cwd: root });
  assert.equal(runCli(['merge-abort', 'T2'], { cwd: root }).code, 3, 'T2 is not the merging ticket');
  const r = runCli(['merge-abort', 'T1'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!existsSync(join(root, '.git', 'MERGE_HEAD')));
  assert.equal(sh(root, ['rev-parse', 'HEAD']), before);
  assert.equal(readFileSync(join(root, 'a/file.txt'), 'utf8'), 'integration\n');
  assert.equal(ticket(root, id, 'T1').status, 'failed');
  const run = loadRun(root, id);
  assert.equal(run.phase, 'running');
  assert.equal(run.merging_ticket, null);
  const hb = events(root, id, 'handback');
  assert.equal(hb.at(-1).ticket, 'T1');
  assert.equal(hb.at(-1).reason, 'merge aborted');
  // the wave can now be settled: T2 merges, next-wave advances
  assert.equal(runCli(['merge-abort', 'T1'], { cwd: root }).code, 3, 'nothing left to abort');
});

test('regression #1: merge-abort also recovers after a manual `git merge --abort`', () => {
  const { root, id } = conflictSetup();
  runCli(['merge', 'T1'], { cwd: root });
  sh(root, ['merge', '--abort']);
  const r = runCli(['merge-abort', 'T1'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(ticket(root, id, 'T1').status, 'failed');
  assert.equal(loadRun(root, id).phase, 'running');
});

test('regression #3: a ready report whose branch has no commits beyond the integration branch is rejected', () => {
  const { root, id, wt } = setup({ commit: false });
  const f = writeJson(root, 'empty.json', {
    status: 'ready', summary: 'Done.', changed_files: ['a/f.txt'], branch: 'worktree-agent-T1',
    commits: [sh(wt.T1, ['rev-parse', 'HEAD'])], checks: [], handbacks: [],
  });
  const r = runCli(['report', 'T1', '--file', f], { cwd: wt.T1 });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no commits/);
  assert.equal(ticket(root, id, 'T1').status, 'running');
  assert.ok(!existsSync(join(stateDir(root), 'runs', id, 'reports', 'T1-1.json')));
});

test('regression #3: a ready report listing a commit that is not on the ticket branch is rejected', () => {
  const { root, id, wt } = setup();
  const other = sh(wt.T2, ['rev-parse', 'HEAD']);
  const f = writeJson(root, 'foreign.json', {
    status: 'ready', summary: 'Done.', changed_files: [], branch: 'worktree-agent-T1',
    commits: [sh(wt.T1, ['rev-parse', 'HEAD']), other], checks: [], handbacks: [],
  });
  const r = runCli(['report', 'T1', '--file', f], { cwd: wt.T1 });
  assert.equal(r.code, 1);
  assert.match(r.stderr, new RegExp(other.slice(0, 12)));
  const bogus = writeJson(root, 'bogus.json', {
    status: 'ready', summary: 'Done.', changed_files: [], branch: 'worktree-agent-T1', commits: ['deadbeef'], checks: [], handbacks: [],
  });
  assert.equal(runCli(['report', 'T1', '--file', bogus], { cwd: wt.T1 }).code, 1);
  assert.equal(ticket(root, id, 'T1').status, 'running');
});

test('regression #3: merge refuses a ready ticket whose branch has nothing beyond the integration branch', () => {
  const { root, id, wt } = setup();
  report(root, 'T1', wt.T1);
  sh(root, ['merge', '-q', '--no-ff', '--no-edit', 'worktree-agent-T1']); // merged by hand already
  const r = runCli(['merge', 'T1'], { cwd: root });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /no commits/);
  assert.equal(ticket(root, id, 'T1').status, 'ready');
  assert.equal(events(root, id, 'merged').length, 0);
  assert.equal(loadRun(root, id).phase, 'running');
});

// ---- final review: finish needs evidence ----

test('regression #8: finish needs a recorded verification (and a review when reviewing), and prints both', () => {
  const { root, id } = setup();
  setPhase(root, 'verifying');
  const none = runCli(['finish'], { cwd: root });
  assert.equal(none.code, 3);
  assert.match(none.stderr, /verify-result/);
  assert.equal(loadRun(root, id).phase, 'verifying');

  assert.equal(runCli(['verify-result', '--passed', 'true'], { cwd: root }).code, 0);
  const noReview = runCli(['finish'], { cwd: root });
  assert.equal(noReview.code, 3);
  assert.match(noReview.stderr, /review/);
  assert.equal(loadRun(root, id).phase, 'reviewing');

  const rv = writeJson(root, 'rv.json', { unmet: [{ item: 'login', evidence: 'no route' }], extras: [], contradictions: [] });
  assert.equal(runCli(['review', '--file', rv], { cwd: root }).code, 0);
  const r = runCli(['finish'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /verification: passed/);
  assert.match(r.stdout, /review 1: 1 unmet, 0 extras, 0 contradictions/);
  assert.equal(loadRun(root, id).phase, 'done');
});

test('regression #8: a verification from before a fix wave does not count for the next verifying phase', () => {
  const { root, id, wt } = setup();
  report(root, 'T1', wt.T1);
  report(root, 'T2', wt.T2);
  for (const t of ['T1', 'T2']) assert.equal(runCli(['merge', t], { cwd: root }).code, 0);
  assert.equal(runCli(['next-wave'], { cwd: root }).code, 0); // wave 2 (T3)
  const f = join(stateDir(root), 'runs', id, 'tickets', 'T3.json');
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), status: 'dropped' }));
  assert.equal(runCli(['next-wave'], { cwd: root }).code, 0); // verifying
  assert.equal(runCli(['verify-result', '--passed', 'false'], { cwd: root }).code, 0);
  const fix = writeJson(root, 'fix.json', { id: 'T4', title: 'Fix', kind: 'fix', wave: 3, scope: 'Fix it', owns: ['a/'], reads: [], contracts: [], done_when: ['ok'] });
  assert.equal(runCli(['add-ticket', '--origin', 'fix', '--file', fix], { cwd: root }).code, 0);
  assert.equal(runCli(['next-wave'], { cwd: root }).code, 0); // running, wave 3
  writeFileSync(join(stateDir(root), 'runs', id, 'tickets', 'T4.json'), JSON.stringify({ ...ticket(root, id, 'T4'), status: 'dropped' }));
  assert.equal(runCli(['next-wave'], { cwd: root }).code, 0); // verifying again
  assert.equal(loadRun(root, id).phase, 'verifying');
  assert.equal(runCli(['finish'], { cwd: root }).code, 3, 'the earlier verification was for the previous verifying phase');
});

// ---- merge-continue judges conflict markers only where the conflict was ----

const UNDERLINE = 'License\n=======\n\nMIT\n';

test('merge-continue accepts a resolved merge when an incoming file has a ======= heading underline', () => {
  const f = setup();
  commitIn(f.wt.T1, 'a/README.md', UNDERLINE);
  conflictTail(f);
  writeFileSync(join(f.root, 'a/file.txt'), 'resolved\n');
  sh(f.root, ['add', 'a/file.txt']);
  const r = runCli(['merge-continue'], { cwd: f.root });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(ticket(f.root, f.id, 'T1').status, 'merged');
  assert.equal(readFileSync(join(f.root, 'a/README.md'), 'utf8'), UNDERLINE);
});

test('merge-continue accepts a hand-committed merge when an incoming file has a ======= heading underline', () => {
  const f = setup();
  commitIn(f.wt.T1, 'a/README.md', UNDERLINE);
  conflictTail(f);
  writeFileSync(join(f.root, 'a/file.txt'), 'resolved\n');
  sh(f.root, ['add', 'a/file.txt']);
  sh(f.root, ['commit', '-q', '--no-edit']);
  const r = runCli(['merge-continue'], { cwd: f.root });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(ticket(f.root, f.id, 'T1').status, 'merged');
});

test('merge-continue accepts a conflicted file resolved to content with a ======= underline', () => {
  const f = setup();
  conflictTail(f);
  writeFileSync(join(f.root, 'a/file.txt'), `resolved\n${UNDERLINE}`);
  sh(f.root, ['add', 'a/file.txt']);
  const r = runCli(['merge-continue'], { cwd: f.root });
  assert.equal(r.code, 0, r.stdout + r.stderr);
});

test('merge-continue still refuses a hand-committed merge with leftover markers in the conflicted file', () => {
  const f = setup();
  commitIn(f.wt.T1, 'a/README.md', UNDERLINE);
  conflictTail(f);
  sh(f.root, ['add', 'a/file.txt']); // markers still in it
  sh(f.root, ['commit', '-q', '--no-edit']);
  const r = runCli(['merge-continue'], { cwd: f.root });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /a\/file\.txt/);
  assert.doesNotMatch(r.stdout, /README/);
  assert.equal(ticket(f.root, f.id, 'T1').status, 'ready');
});

/** Report T1, change a/file.txt on the integration branch, and start the (conflicting) merge. */
function conflictTail(f) {
  report(f.root, 'T1', f.wt.T1);
  commitIn(f.root, 'a/file.txt', 'integration\n');
  assert.equal(runCli(['merge', 'T1'], { cwd: f.root }).code, 3);
}
