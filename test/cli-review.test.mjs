import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { makeRepo, runCli, setPhase } from './helpers.mjs';
import { activeRunId, loadEvents, loadRun, stateDir } from '../lib/state.mjs';
import { coverageErrors } from '../lib/commands/review.mjs';

const sh = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};

function plan() {
  const t = (id, dir) => ({ id, title: id, kind: 'work', wave: 1, scope: `Build ${dir}`, owns: [`${dir}/`], reads: [], contracts: [], done_when: ['works'] });
  return {
    title: 'Review me',
    charter: { idea: 'Review me.', in_scope: ['a'], out_of_scope: [], allowed_actions: [] },
    project: { kind: 'existing', stack: null, setup: [], checks: ['true'], integration_checks: [] },
    contracts: [],
    tickets: [t('T1', 'a')],
  };
}

/** Approved run (on its integration branch, phase running). */
function setup() {
  const root = makeRepo();
  assert.equal(runCli(['init', '--title', 'Review me'], { cwd: root }).code, 0);
  const id = activeRunId(root);
  const f = join(stateDir(root), 'drafts', 'plan.json');
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(plan()));
  assert.equal(runCli(['propose', f], { cwd: root }).code, 0);
  assert.equal(runCli(['approve'], { cwd: root }).code, 0);
  return { root, id };
}

const reviewing = () => {
  const f = setup();
  setPhase(f.root, 'reviewing');
  return f;
};

function setupWorktree(root) {
  const r = runCli(['review-setup'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  const path = r.stdout.trim();
  assert.ok(path !== '', 'review-setup prints the worktree path');
  return path;
}

const registeredWorktrees = (root) => sh(root, ['worktree', 'list', '--porcelain'])
  .split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));
const isRegistered = (root, path) => registeredWorktrees(root).some((p) => basename(p) === basename(path));

const close = (root) => runCli(['review-close'], { cwd: root });
const events = (root, id, type) => loadEvents(root, id).filter((e) => e.type === type);
const reviewEvents = (root, id) => events(root, id, 'reviewed');

const tmpFile = (() => {
  let n = 0;
  return (obj) => {
    const f = join(tmpdir(), `superagent-review-fixture-${process.pid}-${n++}.json`);
    writeFileSync(f, JSON.stringify(obj));
    return f;
  };
})();

/** A review the contract accepts. */
const validReview = () => ({ met: [{ item: 'a', evidence: 'README.md' }], unmet: [], extras: [], contradictions: [] });

test('review-setup is refused outside the reviewing phase', () => {
  const { root, id } = setup();
  const r = runCli(['review-setup'], { cwd: root });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /expected reviewing/);
  assert.equal(loadRun(root, id).review_worktree ?? null, null);
  setPhase(root, 'proposing');
  assert.equal(runCli(['review-setup'], { cwd: root }).code, 3);
});

test('review-setup creates a detached worktree with no run state, prints its path alone, and records it', () => {
  const { root, id } = reviewing();
  const r = runCli(['review-setup'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').length, 1, 'prints the path alone');
  const path = r.stdout.trim();
  assert.match(basename(path), new RegExp(`^superagent-review-${id}-[0-9a-f]{8}$`));
  assert.equal(dirname(path), tmpdir());
  assert.ok(existsSync(path), 'the worktree exists');
  assert.ok(existsSync(join(path, 'README.md')), 'the integration branch content is checked out');
  assert.ok(!existsSync(join(path, '.superagent')), 'no run state is copied into the worktree');
  assert.ok(!existsSync(join(path, '.superagent', 'runs')), 'no runs directory');
  assert.ok(!existsSync(join(path, '.superagent', 'runs', id, 'tickets')), 'no tickets');
  // Detached at the integration branch, and registered with git.
  const run = loadRun(root, id);
  assert.equal(sh(path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD');
  assert.equal(sh(path, ['rev-parse', 'HEAD']), sh(root, ['rev-parse', run.integration_branch]));
  assert.ok(isRegistered(root, path));
  assert.equal(loadRun(root, id).review_worktree, path);
  const created = events(root, id, 'review_worktree_created');
  assert.equal(created.length, 1);
  assert.equal(created[0].path, path);
  assert.equal(close(root).code, 0);
  assert.ok(!existsSync(path));
});

test('review-setup is idempotent while the stored worktree exists', () => {
  const { root, id } = reviewing();
  const path = setupWorktree(root);
  const again = runCli(['review-setup'], { cwd: root });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout.trim(), path);
  assert.equal(loadRun(root, id).review_worktree, path);
  assert.equal(events(root, id, 'review_worktree_created').length, 1);
  assert.equal(registeredWorktrees(root).filter((p) => basename(p) === basename(path)).length, 1, 'no second worktree is created');
  assert.equal(close(root).code, 0);
});

test('review-close removes the worktree, clears the field, and is safe to repeat', () => {
  const { root, id } = reviewing();
  const path = setupWorktree(root);
  assert.ok(existsSync(path));
  const r = close(root);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'review worktree removed\n');
  assert.ok(!existsSync(path));
  assert.equal(loadRun(root, id).review_worktree, null);
  assert.equal(events(root, id, 'review_worktree_removed').length, 1);
  assert.equal(events(root, id, 'review_worktree_removed')[0].path, path);
  assert.ok(!isRegistered(root, path));
  const again = close(root);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout, 'review worktree removed\n');
  assert.equal(loadRun(root, id).review_worktree, null);
  assert.equal(events(root, id, 'review_worktree_removed').length, 2);
});

test('review-close is safe when the worktree directory is already gone', () => {
  const { root, id } = reviewing();
  const path = setupWorktree(root);
  rmSync(path, { recursive: true, force: true });
  const r = close(root);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'review worktree removed\n');
  assert.equal(loadRun(root, id).review_worktree, null);
  assert.ok(!existsSync(path));
});

test('review accepts an absolute --file path, stores met alongside the other lists, and records counts', () => {
  const { root, id } = reviewing();
  const path = setupWorktree(root);
  const data = {
    met: [{ item: 'a', evidence: 'a/file.txt' }, { item: 'a derived extra observation', evidence: 'README.md' }],
    unmet: [{ item: 'an out-of-scope observation', evidence: 'no route' }],
    extras: [],
    contradictions: [],
  };
  // The review worktree is where the reviewer writes it: <worktree>/.superagent/drafts/<run id>/review.json.
  const file = join(path, '.superagent', 'drafts', id, 'review.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
  const r = runCli(['review', '--file', file], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /review 1 recorded/);
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir(root), 'runs', id, 'reviews', '1.json'), 'utf8')), data);
  assert.equal(reviewEvents(root, id).length, 1);
  assert.equal(reviewEvents(root, id)[0].met, 2);
  assert.equal(close(root).code, 0);
});

test('review rejects a missing or invalid met list and stores nothing', () => {
  const { root, id } = reviewing();
  const dir = join(stateDir(root), 'runs', id, 'reviews');
  const cases = [
    [{ unmet: [], extras: [], contradictions: [] }, /met must be an array of \{ item, evidence \}/],
    [{ met: 'x', unmet: [], extras: [], contradictions: [] }, /met must be an array/],
    [{ met: [{ item: 'a' }], unmet: [], extras: [], contradictions: [] }, /met\[0\] must be \{ item, evidence \} with non-empty strings/],
    [{ met: [{ item: '', evidence: 'README.md' }], unmet: [], extras: [], contradictions: [] }, /met\[0\]/],
    [{ met: [{ item: 'a', evidence: '  ' }], unmet: [], extras: [], contradictions: [] }, /met\[0\]/],
  ];
  for (const [data, re] of cases) {
    const r = runCli(['review', '--file', tmpFile(data)], { cwd: root });
    assert.equal(r.code, 1, JSON.stringify(data));
    assert.match(r.stderr, re, JSON.stringify(data));
    assert.ok(!existsSync(dir), `no review is stored for ${JSON.stringify(data)}`);
  }
  // `met: []` no longer passes: the Charter's one in-scope item ("a") must be assessed.
  const empty = runCli(['review', '--file', tmpFile({ met: [], unmet: [], extras: [], contradictions: [] })], { cwd: root });
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /does not assess in-scope Charter item "a"/);
  assert.ok(!existsSync(dir), 'no review is stored');
});

test('coverageErrors requires every in-scope Charter item in exactly one of met or unmet', () => {
  const item = (name) => ({ item: name, evidence: 'x' });
  assert.deepEqual(coverageErrors(['a', 'b'], { met: [item('a')], unmet: [item('b')] }), []);
  assert.deepEqual(
    coverageErrors(['a'], { met: [item('a'), item('a')], unmet: [] }).length,
    0,
    'duplicates in met are not a coverage failure',
  );
  assert.match(coverageErrors(['a', 'b'], { met: [item('a')], unmet: [] })[0], /does not assess.*"b"/);
  assert.match(coverageErrors(['a'], { met: [item('a')], unmet: [item('a')] })[0], /both met and unmet/);
  assert.deepEqual(coverageErrors([], { met: [], unmet: [] }), []);
  assert.deepEqual(
    coverageErrors(['a  b'], { met: [{ item: 'a b', evidence: 'x' }], unmet: [] }),
    [],
    'whitespace is normalized',
  );
});
