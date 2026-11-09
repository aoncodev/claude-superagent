import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, runHook } from './helpers.mjs';

const READ = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'hooks', 'guard-read.mjs');
const REVIEWER = { agent_type: 'superagent:fidelity-reviewer', agent_id: 'r1' };
const REASON = 'Blocked: the fidelity reviewer may read only its review worktree.';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A repo with an active `reviewing` run whose review_worktree is a real linked worktree of it. */
function setup(runExtra = {}) {
  const root = makeRepo();
  const review = join(realpathSync(mkdtempSync(join(tmpdir(), 'superagent-review-wt-'))), 'wt');
  git(root, ['worktree', 'add', '-q', '--detach', review, 'HEAD']);
  mkdirSync(join(review, 'src'), { recursive: true });
  writeFileSync(join(review, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(review, 'README.md'), '# review\n');
  const runDir = join(root, '.superagent', 'runs', 'r1');
  mkdirSync(join(runDir, 'tickets'), { recursive: true });
  writeFileSync(join(root, '.superagent', 'active'), 'r1\n');
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({
    id: 'r1', title: 't', phase: 'reviewing', allowed_actions: [], integration_branch: 'superagent/r1', review_worktree: review, ...runExtra,
  }));
  return { root, review };
}

const payload = (cwd, tool_name, tool_input, extra = {}) => ({ cwd, tool_name, tool_input, hook_event_name: 'PreToolUse', ...extra });
const reviewerPayload = (cwd, tool_name, tool_input) => payload(cwd, tool_name, tool_input, REVIEWER);
const denyReason = (r) => {
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
};
const allowed = (r) => { assert.equal(r.code, 0); assert.equal(r.stdout, ''); };

test('guard-read: every non-reviewer caller is allowed silently', () => {
  const { root, review } = setup();
  allowed(runHook(READ, payload(root, 'Read', { file_path: join(root, 'README.md') })));
  allowed(runHook(READ, payload(root, 'Read', { file_path: join(root, '.superagent/runs/r1/run.json') }, { agent_type: 'superagent:worker' })));
  allowed(runHook(READ, payload(review, 'Grep', { pattern: 'a', path: review }, { agent_type: 'superagent:orchestrator' })));
  allowed(runHook(READ, payload(root, 'Glob', { pattern: '**/*' }, { agent_type: 'some-other-agent' })));
});

test('guard-read: the reviewer may read inside its review worktree', () => {
  const { root, review } = setup();
  allowed(runHook(READ, reviewerPayload(root, 'Read', { file_path: join(review, 'src/a.ts') })));
  allowed(runHook(READ, reviewerPayload(review, 'Read', { file_path: 'src/a.ts' })));
  allowed(runHook(READ, reviewerPayload(review, 'Read', { file_path: join(review, 'src/a.ts') })));
  allowed(runHook(READ, reviewerPayload(root, 'Grep', { pattern: 'a', path: join(review, 'src') })));
  allowed(runHook(READ, reviewerPayload(review, 'Grep', { pattern: 'a' })));
  allowed(runHook(READ, reviewerPayload(root, 'Glob', { pattern: '**/*.ts', path: join(review, 'src') })));
  allowed(runHook(READ, reviewerPayload(review, 'Glob', { pattern: '**/*.ts' })));
});

test('guard-read: the reviewer is denied the main checkout, run state and the default cwd', () => {
  const { root, review } = setup();
  const denied = [
    ['Read', { file_path: join(root, 'README.md') }, root],
    ['Read', { file_path: 'README.md' }, root],
    ['Read', { file_path: join(root, '.superagent/runs/r1/run.json') }, root],
    ['Read', { file_path: join(root, '.superagent/drafts/r1/review.json') }, root],
    ['Read', { path: join(review, 'src/a.ts') }, root], // Read ignores `path`
    ['Grep', { pattern: 'a', path: root }, root],
    ['Grep', { pattern: 'a', path: join(review, '..') }, root],
    ['Grep', { pattern: 'a' }, root],
    ['Grep', { pattern: 'a', path: '' }, root],
    ['Glob', { pattern: '**/*', path: root }, root],
    ['Glob', { pattern: '**/*' }, root],
  ];
  for (const [tool, input, cwd] of denied) {
    const r = runHook(READ, reviewerPayload(cwd, tool, input));
    assert.equal(denyReason(r), REASON, `${tool} ${JSON.stringify(input)}`);
    assert.equal(r.stderr, '');
  }
});

test('guard-read: symlinks and link/.. may not lead out of the review worktree', () => {
  const { root, review } = setup();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'secret.ts'), 'secret\n');
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'superagent-read-outside-')));
  writeFileSync(join(outside, 'secret.txt'), 'secret\n');
  // A symlink, its /.. parent, and a symlinked directory: all resolve outside the review worktree.
  symlinkSync(join(outside, 'secret.txt'), join(review, 'leak-file'));
  symlinkSync(outside, join(review, 'leak-dir'));
  symlinkSync(join(root, 'src'), join(review, 'up'));
  for (const rel of ['leak-file', 'leak-dir/secret.txt', 'up/secret.ts', 'up/../README.md']) {
    assert.equal(denyReason(runHook(READ, reviewerPayload(review, 'Read', { file_path: rel }))), REASON, rel);
  }
  // A symlink that stays inside the review worktree is fine.
  symlinkSync(join(review, 'src'), join(review, 'alias'));
  allowed(runHook(READ, reviewerPayload(review, 'Read', { file_path: 'alias/a.ts' })));
});

test('guard-read: with no review worktree recorded, the reviewer is denied everything', () => {
  const { root, review } = setup({ review_worktree: null });
  for (const p of [join(root, 'README.md'), join(review, 'src/a.ts')]) {
    assert.equal(denyReason(runHook(READ, reviewerPayload(root, 'Read', { file_path: p }))), REASON, p);
  }
  const empty = setup({ review_worktree: '' });
  assert.equal(denyReason(runHook(READ, reviewerPayload(empty.root, 'Glob', { pattern: '**/*' }))), REASON);
});

test('guard-read: a review worktree that is or contains the main checkout grants nothing', () => {
  for (const kind of ['root', 'tmpdir']) {
    const { root, review } = setup();
    const value = kind === 'root' ? root : realpathSync(tmpdir());
    writeFileSync(join(root, '.superagent', 'runs', 'r1', 'run.json'), JSON.stringify({
      id: 'r1', title: 't', phase: 'reviewing', allowed_actions: [], integration_branch: 'superagent/r1', review_worktree: value,
    }));
    assert.equal(denyReason(runHook(READ, reviewerPayload(root, 'Read', { file_path: join(root, 'README.md') }))), REASON, kind);
    assert.equal(denyReason(runHook(READ, reviewerPayload(review, 'Read', { file_path: join(review, 'README.md') }))), REASON, kind);
  }
});

test('guard-read: unreadable or missing state fails open with a warning', () => {
  const corrupt = setup();
  writeFileSync(join(corrupt.root, '.superagent', 'runs', 'r1', 'run.json'), '{ not json');
  const c = runHook(READ, reviewerPayload(corrupt.root, 'Read', { file_path: join(corrupt.root, 'README.md') }));
  allowed(c);
  assert.match(c.stderr, /^superagent guard: .+ \(allowing\)\n$/);

  const inactive = setup();
  writeFileSync(join(inactive.root, '.superagent', 'active'), '');
  const i = runHook(READ, reviewerPayload(inactive.root, 'Read', { file_path: join(inactive.root, 'README.md') }));
  allowed(i);
  assert.match(i.stderr, /^superagent guard: .+ \(allowing\)\n$/);

  const ghost = setup();
  writeFileSync(join(ghost.root, '.superagent', 'active'), 'no-such-run\n');
  const g = runHook(READ, reviewerPayload(ghost.root, 'Read', { file_path: join(ghost.root, 'README.md') }));
  allowed(g);
  assert.match(g.stderr, /^superagent guard: .+ \(allowing\)\n$/);
});

test('guard-read: no state directory or no git repo means nothing to guard', () => {
  const bare = makeRepo();
  const b = runHook(READ, reviewerPayload(bare, 'Read', { file_path: join(bare, 'README.md') }));
  allowed(b);
  assert.equal(b.stderr, '');

  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'superagent-norepo-')));
  const n = runHook(READ, reviewerPayload(dir, 'Read', { file_path: join(dir, 'a.ts') }));
  allowed(n);
  assert.equal(n.stderr, '');
});

test('guard-read: malformed stdin fails open with a warning', () => {
  const r = spawnSync('node', [READ], { input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^superagent guard: .+ \(allowing\)\n$/);
});
