import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRepo } from './helpers.mjs';
import {
  StateError, stateDir, ensureStateDir, readConfig, createRun, activeRunId, loadRun, saveRun,
  loadTickets, saveTicket, appendEvent, charterPath, readCharter,
} from '../lib/state.mjs';
import { mainRoot, worktreeContaining, dirtyFiles, diffNames, hasHead, git } from '../lib/git.mjs';

const sh = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test('createRun writes run.json with phase proposing and sets active', () => {
  const root = makeRepo();
  const run = createRun(root, { title: 'Build a Thing' });
  assert.equal(run.phase, 'proposing');
  assert.equal(activeRunId(root), run.id);
  assert.deepEqual(loadRun(root, run.id), run);
  assert.equal(run.repo_root, root);
  assert.equal(run.charter_rev, 1);
  assert.equal(run.charter_sha256, null);
  assert.equal(run.parallelism, 4);
  assert.deepEqual(run.fix_waves_used, { fix: 0, fidelity: 0 });
});

test('run id is YYYYMMDD-HHMM-<slug>, slug is [a-z0-9-] up to 40 chars, collisions get -2, -3', () => {
  const root = makeRepo();
  const a = createRun(root, { title: 'Hello, World! Ünïcode  &  Stuff' });
  assert.match(a.id, /^\d{8}-\d{4}-hello-world-n-code-stuff$/);
  const long = createRun(root, { title: 'x'.repeat(100) });
  assert.match(long.id, /^\d{8}-\d{4}-x{40}$/);
  const b = createRun(root, { title: 'Hello, World! Ünïcode  &  Stuff' });
  const c = createRun(root, { title: 'Hello, World! Ünïcode  &  Stuff' });
  assert.equal(b.id, `${a.id}-2`);
  assert.equal(c.id, `${a.id}-3`);
});

test('ensureStateDir adds .superagent/ to .git/info/exclude exactly once', () => {
  const root = makeRepo();
  ensureStateDir(root);
  ensureStateDir(root);
  const lines = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8').split('\n');
  assert.equal(lines.filter((l) => l === '.superagent/').length, 1);
  assert.ok(existsSync(stateDir(root)));
  writeFileSync(join(stateDir(root), 'x'), 'x');
  assert.equal(sh(root, ['status', '--porcelain']), '');
});

test('ensureStateDir also excludes .claude/worktrees/ exactly once', () => {
  const root = makeRepo();
  ensureStateDir(root);
  ensureStateDir(root);
  const lines = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8').split('\n');
  assert.equal(lines.filter((l) => l === '.claude/worktrees/').length, 1);
  mkdirSync(join(root, '.claude', 'worktrees', 'agent-1'), { recursive: true });
  writeFileSync(join(root, '.claude', 'worktrees', 'agent-1', 'f.txt'), 'x');
  assert.equal(sh(root, ['status', '--porcelain']), '');
});

test('ensureStateDir keeps an exclude file lacking a trailing newline intact', () => {
  const root = makeRepo();
  const p = join(root, '.git', 'info', 'exclude');
  mkdirSync(join(root, '.git', 'info'), { recursive: true });
  writeFileSync(p, '*.log');
  ensureStateDir(root);
  const lines = readFileSync(p, 'utf8').split('\n');
  assert.ok(lines.includes('*.log'));
  assert.ok(lines.includes('.superagent/'));
});

test('dirtyFiles ignores .superagent/ and .claude/worktrees/ but lists other changes', () => {
  const root = makeRepo({});
  mkdirSync(join(root, '.superagent'), { recursive: true });
  mkdirSync(join(root, '.claude', 'worktrees', 'agent-1'), { recursive: true });
  writeFileSync(join(root, '.superagent', 'a'), 'x');
  writeFileSync(join(root, '.claude', 'worktrees', 'agent-1', 'b'), 'x');
  assert.deepEqual(dirtyFiles(root), []);
  writeFileSync(join(root, 'README.md'), 'changed\n');
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', 'new file.txt'), 'x');
  assert.deepEqual(dirtyFiles(root).sort(), ['README.md', 'sub/new file.txt']);
});

test('loadRun on invalid JSON throws StateError naming run.json', () => {
  const root = makeRepo();
  const run = createRun(root, { title: 't' });
  writeFileSync(join(stateDir(root), 'runs', run.id, 'run.json'), '{not json');
  assert.throws(() => loadRun(root, run.id), (e) => e instanceof StateError && /run\.json/.test(e.message));
});

test('loadRun on a missing run throws StateError naming run.json', () => {
  const root = makeRepo();
  assert.throws(() => loadRun(root, 'nope'), (e) => e instanceof StateError && /run\.json/.test(e.message));
});

test('saveRun round-trips and leaves no temp files', () => {
  const root = makeRepo();
  const run = createRun(root, { title: 't' });
  run.phase = 'running';
  saveRun(root, run);
  assert.equal(loadRun(root, run.id).phase, 'running');
  const names = spawnSync('ls', [join(stateDir(root), 'runs', run.id)], { encoding: 'utf8' }).stdout;
  assert.ok(!/tmp/.test(names), names);
});

test('mainRoot from inside a linked worktree returns the main checkout', () => {
  const root = makeRepo();
  const wt = join(mkdtempSync(join(tmpdir(), 'superagent-wt-')), 'wt');
  sh(root, ['worktree', 'add', '-q', wt, '-b', 'side']);
  assert.equal(mainRoot(wt), root);
  assert.equal(mainRoot(root), root);
  assert.equal(mainRoot(join(root)), root);
});

test('worktreeContaining picks the longest-prefix worktree', () => {
  const root = makeRepo();
  ensureStateDir(root);
  const wt = join(root, '.claude', 'worktrees', 'agent-1');
  sh(root, ['worktree', 'add', '-q', wt, '-b', 'worker']);
  const inner = worktreeContaining(join(wt, 'src', 'a.js'), root);
  assert.equal(inner.path, realpathSync(wt));
  assert.equal(inner.branch, 'worker');
  assert.equal(inner.isMain, false);
  const outer = worktreeContaining(join(root, 'README.md'), root);
  assert.equal(outer.path, root);
  assert.equal(outer.branch, 'main');
  assert.equal(outer.isMain, true);
  assert.equal(worktreeContaining(tmpdir(), root), null);
});

test('hasHead and diffNames', () => {
  const empty = makeRepo({ commit: false });
  assert.equal(hasHead(empty), false);
  const root = makeRepo();
  assert.equal(hasHead(root), true);
  sh(root, ['checkout', '-q', '-b', 'f']);
  writeFileSync(join(root, 'n.txt'), 'n');
  sh(root, ['add', '.']);
  sh(root, ['commit', '-q', '-m', 'n']);
  assert.deepEqual(diffNames(root, 'main', 'f'), ['n.txt']);
  assert.match(git(['rev-parse', 'HEAD'], root), /^[0-9a-f]{40}$/);
  assert.throws(() => git(['rev-parse', 'nonexistent-ref'], root), /nonexistent-ref/);
});

test('readConfig defaults parallelism to 4', () => {
  const root = makeRepo();
  assert.deepEqual(readConfig(root), { parallelism: 4, production_markers: [], worker_model: 'inherit' });
});

test('readConfig reads overrides and rejects parallelism 9 with StateError', () => {
  const root = makeRepo();
  ensureStateDir(root);
  writeFileSync(join(stateDir(root), 'config.json'), JSON.stringify({ parallelism: 2, production_markers: ['prod'] }));
  assert.deepEqual(readConfig(root), { parallelism: 2, production_markers: ['prod'], worker_model: 'inherit' });
  writeFileSync(join(stateDir(root), 'config.json'), JSON.stringify({ parallelism: 9 }));
  assert.throws(() => readConfig(root), (e) => e instanceof StateError && /config\.json/.test(e.message));
  writeFileSync(join(stateDir(root), 'config.json'), '{bad');
  assert.throws(() => readConfig(root), StateError);
});

test('createRun uses the configured parallelism', () => {
  const root = makeRepo();
  ensureStateDir(root);
  writeFileSync(join(stateDir(root), 'config.json'), JSON.stringify({ parallelism: 3 }));
  assert.equal(createRun(root, { title: 't' }).parallelism, 3);
});

test('tickets are sorted by wave then numeric id; bad ids are rejected', () => {
  const root = makeRepo();
  const run = createRun(root, { title: 't' });
  const mk = (id, wave) => ({ id, title: id, kind: 'work', wave, status: 'planned' });
  saveTicket(root, run.id, mk('T10', 1));
  saveTicket(root, run.id, mk('T2', 1));
  saveTicket(root, run.id, mk('T1', 2));
  saveTicket(root, run.id, mk('T3', 0));
  assert.deepEqual(loadTickets(root, run.id).map((t) => t.id), ['T3', 'T2', 'T10', 'T1']);
  assert.throws(() => saveTicket(root, run.id, mk('../x', 1)), StateError);
  assert.deepEqual(loadTickets(root, 'no-such-run'), []);
});

test('appendEvent writes one JSON line per event', () => {
  const root = makeRepo();
  const run = createRun(root, { title: 't' });
  appendEvent(root, run.id, 'custom', { a: 1 });
  const lines = readFileSync(join(stateDir(root), 'runs', run.id, 'events.jsonl'), 'utf8').trim().split('\n');
  const last = JSON.parse(lines.at(-1));
  assert.equal(last.type, 'custom');
  assert.equal(last.a, 1);
  assert.ok(!Number.isNaN(Date.parse(last.ts)));
  assert.equal(JSON.parse(lines[0]).type, 'created');
});

test('charterPath and readCharter', () => {
  const root = makeRepo();
  const run = createRun(root, { title: 't' });
  assert.equal(charterPath(root, run), join(stateDir(root), 'runs', run.id, 'charter.r1.md'));
  assert.throws(() => readCharter(root, run), (e) => e instanceof StateError && /charter\.r1\.md/.test(e.message));
  writeFileSync(charterPath(root, run), '# Charter\n');
  assert.equal(readCharter(root, run), '# Charter\n');
});

test('diffNames returns non-ASCII paths unquoted', () => {
  const root = makeRepo();
  sh(root, ['checkout', '-q', '-b', 'f']);
  writeFileSync(join(root, 'ü.txt'), 'n');
  writeFileSync(join(root, 'plain.txt'), 'n');
  sh(root, ['add', '.']);
  sh(root, ['commit', '-q', '-m', 'n']);
  assert.deepEqual(diffNames(root, 'main', 'f').sort(), ['plain.txt', 'ü.txt']);
});
