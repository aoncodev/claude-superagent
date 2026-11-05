import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, runCli, setPhase } from './helpers.mjs';
import { hasHead } from '../lib/git.mjs';
import { activeRunId, loadRun, saveTicket, charterPath, stateDir } from '../lib/state.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sh = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();

function initRun(root, title = 'My Task') {
  const r = runCli(['init', '--title', title], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  return activeRunId(root);
}

function emptyDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'superagent-empty-')));
}

test('init in a non-repo without --git-init exits 1 and says to pass --git-init', () => {
  const dir = emptyDir();
  const r = runCli(['init', '--title', 'x'], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--git-init/);
  assert.ok(!existsSync(join(dir, '.git')));
});

test('init --git-init in an empty dir creates a repo with an initial empty commit', () => {
  const dir = emptyDir();
  const r = runCli(['init', '--title', 'Fresh Start', '--git-init'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(hasHead(dir), true);
  const id = activeRunId(dir);
  assert.match(id, /^\d{8}-\d{4}-fresh-start$/);
  assert.equal(loadRun(dir, id).phase, 'proposing');
  assert.match(r.stdout, new RegExp(id));
});

test('init requires --title', () => {
  const r = runCli(['init'], { cwd: makeRepo() });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--title/);
});

test('init in a repo with no commits needs --git-init, and it then makes the first commit', () => {
  const root = makeRepo({ commit: false });
  assert.equal(runCli(['init', '--title', 'x'], { cwd: root }).code, 1);
  const r = runCli(['init', '--title', 'x', '--git-init'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(hasHead(root), true);
});

test('init from a subdirectory records the repo root and refuses a second live run', () => {
  const root = makeRepo();
  mkdirSync(join(root, 'sub'));
  const r = runCli(['init', '--title', 'x'], { cwd: join(root, 'sub') });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(loadRun(root, activeRunId(root)).repo_root, root);
  const again = runCli(['init', '--title', 'y'], { cwd: root });
  assert.equal(again.code, 3);
  assert.match(again.stderr, /abort/);
});

test('approve with no active run exits 2', () => {
  const r = runCli(['approve'], { cwd: makeRepo() });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no active run/);
});

test('approve refuses when phase is not awaiting_approval (exit 3, #9)', () => {
  const root = makeRepo();
  initRun(root);
  const r = runCli(['approve'], { cwd: root });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /awaiting_approval/);
});

test('regression #4: there is no `phase` command to jump the state machine', () => {
  const root = makeRepo();
  const id = initRun(root);
  const r = runCli(['phase', 'running'], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown command: phase/);
  assert.doesNotMatch(r.stderr, /commands:.*\bphase\b/);
  assert.equal(loadRun(root, id).phase, 'proposing');
});

test('approve refuses on a dirty tree and lists the dirty files', () => {
  const root = makeRepo();
  initRun(root);
  writeFileSync(join(root, 'a.txt'), 'x');
  setPhase(root, 'awaiting_approval');
  const r = runCli(['approve'], { cwd: root });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /a\.txt/);
  assert.ok(existsSync(join(root, 'a.txt')));
  assert.equal(sh(root, ['branch', '--show-current']), 'main');
});

test('approve with a missing charter file exits 2 naming the file', () => {
  const root = makeRepo();
  initRun(root);
  setPhase(root, 'awaiting_approval');
  const r = runCli(['approve'], { cwd: root });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /charter\.r1\.md/);
});

test('approve on a clean tree freezes the charter', () => {
  const root = makeRepo();
  const id = initRun(root);
  const run0 = loadRun(root, id);
  const charter = '# Charter\n\nBuild it.\n';
  writeFileSync(charterPath(root, run0), charter);
  setPhase(root, 'awaiting_approval');
  const head = sh(root, ['rev-parse', 'HEAD']);
  const r = runCli(['approve'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  const run = loadRun(root, id);
  assert.equal(run.charter_sha256, createHash('sha256').update(charter).digest('hex'));
  assert.equal(run.integration_branch, `superagent/${id}`);
  assert.equal(sh(root, ['branch', '--show-current']), `superagent/${id}`);
  assert.equal(run.base_branch, 'main');
  assert.equal(run.base_sha, head);
  assert.equal(run.phase, 'running');
  assert.equal(run.current_wave, null);
  const events = readFileSync(join(stateDir(root), 'runs', id, 'events.jsonl'), 'utf8');
  assert.match(events, /"type":"approved"/);
});

test('approve sets current_wave to the lowest ticket wave', () => {
  const root = makeRepo();
  const id = initRun(root);
  writeFileSync(charterPath(root, loadRun(root, id)), '# c\n');
  for (const [tid, wave] of [['T1', 2], ['T2', 1], ['T3', 3]]) {
    saveTicket(root, id, { id: tid, title: tid, kind: 'work', wave, status: 'planned' });
  }
  setPhase(root, 'awaiting_approval');
  assert.equal(runCli(['approve'], { cwd: root }).code, 0);
  assert.equal(loadRun(root, id).current_wave, 1);
});

test('approve works from inside a subdirectory and honours --run', () => {
  const root = makeRepo();
  const id = initRun(root);
  writeFileSync(charterPath(root, loadRun(root, id)), '# c\n');
  setPhase(root, 'awaiting_approval', id);
  mkdirSync(join(root, 'sub'));
  assert.equal(runCli(['approve', '--run', id], { cwd: join(root, 'sub') }).code, 0);
  assert.equal(loadRun(root, id).phase, 'running');
});

test('abort sets phase aborted, clears active, and leaves branches untouched', () => {
  const root = makeRepo();
  const id = initRun(root);
  writeFileSync(charterPath(root, loadRun(root, id)), '# c\n');
  setPhase(root, 'awaiting_approval');
  runCli(['approve'], { cwd: root });
  const branchesBefore = sh(root, ['branch', '--list']);
  const r = runCli(['abort'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(loadRun(root, id).phase, 'aborted');
  assert.equal(activeRunId(root), null);
  assert.equal(sh(root, ['branch', '--list']), branchesBefore);
  assert.equal(runCli(['abort', '--run', id], { cwd: root }).code, 0);
  // a new run can start afterwards
  assert.equal(runCli(['init', '--title', 'next'], { cwd: root }).code, 0);
});

test('show prints a summary, --json prints {run, tickets, lastReports}, --charter prints the file verbatim', () => {
  const root = makeRepo();
  const id = initRun(root, 'Show Me');
  const run = loadRun(root, id);
  const charter = '# Charter\r\n\n  weird   spacing\n';
  writeFileSync(charterPath(root, run), charter);
  saveTicket(root, id, { id: 'T1', title: 'one', kind: 'work', wave: 1, status: 'planned' });
  const plain = runCli(['show'], { cwd: root });
  assert.equal(plain.code, 0, plain.stderr);
  assert.match(plain.stdout, new RegExp(id));
  assert.match(plain.stdout, /proposing/);
  const j = runCli(['show', '--json'], { cwd: root });
  const data = JSON.parse(j.stdout);
  assert.equal(data.run.id, id);
  assert.deepEqual(data.tickets.map((t) => t.id), ['T1']);
  assert.deepEqual(data.lastReports, {});
  const c = runCli(['show', '--charter'], { cwd: root });
  assert.equal(c.stdout, charter);
  assert.equal(runCli(['show', '--json', '--charter'], { cwd: root }).code, 1);
});

test('unknown command and no command exit 1', () => {
  const root = makeRepo();
  assert.equal(runCli(['frobnicate'], { cwd: root }).code, 1);
  assert.equal(runCli([], { cwd: root }).code, 1);
});

test('corrupt run.json yields exit 2 naming run.json', () => {
  const root = makeRepo();
  const id = initRun(root);
  writeFileSync(join(stateDir(root), 'runs', id, 'run.json'), '{oops');
  const r = runCli(['show'], { cwd: root });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /run\.json/);
});

test('bin/superagent shim is executable and works via PATH-style invocation', () => {
  const shim = join(ROOT, 'bin', 'superagent');
  assert.equal(statSync(shim).mode & 0o777, 0o755);
  const first = readFileSync(shim, 'utf8').split('\n');
  assert.equal(first[0], '#!/usr/bin/env node');
  assert.equal(first[1], "import './superagent.mjs';");
  const root = makeRepo();
  const r = spawnSync(shim, ['init', '--title', 'via shim'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(activeRunId(root));
});

test('abort clears the active pointer when run.json is corrupt, leaves the run folder, and init then succeeds', () => {
  const root = makeRepo();
  const id = initRun(root);
  const file = join(stateDir(root), 'runs', id, 'run.json');
  writeFileSync(file, '{oops');
  assert.equal(runCli(['init', '--title', 'blocked'], { cwd: root }).code, 3);
  const r = runCli(['abort'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /run\.json/);
  assert.equal(activeRunId(root), null);
  assert.equal(readFileSync(file, 'utf8'), '{oops');
  assert.equal(runCli(['init', '--title', 'next'], { cwd: root }).code, 0);
});

test('abort clears a stale active pointer to a run that does not exist', () => {
  const root = makeRepo();
  initRun(root);
  writeFileSync(join(stateDir(root), 'active'), 'gone-run\n');
  const r = runCli(['abort'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(activeRunId(root), null);
});

// ---- final review: CLI consistency ----

test('regression #9: abort of a finished run is a refusal (exit 3)', () => {
  const root = makeRepo();
  const id = initRun(root);
  setPhase(root, 'done');
  const r = runCli(['abort', '--run', id], { cwd: root });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /already done/);
});

test('regression #6: show --run prints only the run object, never tickets or reports', () => {
  const root = makeRepo();
  const id = initRun(root, 'Show Run');
  saveTicket(root, id, { id: 'T1', title: 'secret ticket', kind: 'work', wave: 1, status: 'planned' });
  const r = runCli(['show', '--run'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.equal(data.id, id);
  assert.equal(data.phase, 'proposing');
  assert.ok(!('tickets' in data) && !('lastReports' in data));
  assert.doesNotMatch(r.stdout, /secret ticket/);
  assert.equal(runCli(['show', '--run', '--json'], { cwd: root }).code, 1);
  assert.equal(runCli(['show', '--run', '--charter'], { cwd: root }).code, 1);
  // --run <id> still selects a run
  assert.equal(JSON.parse(runCli(['show', '--run', id, '--json'], { cwd: root }).stdout).run.id, id);
});

/** An approved run with a worker worktree for T1 (the orchestrator-only commands are tried from there). */
function approvedWithWorktree() {
  const root = makeRepo();
  const id = initRun(root);
  const drafts = join(stateDir(root), 'drafts');
  mkdirSync(drafts, { recursive: true });
  writeFileSync(join(drafts, 'plan.json'), JSON.stringify({
    title: 't', charter: { idea: 'i', in_scope: [], out_of_scope: [], allowed_actions: [] },
    project: { kind: 'existing', stack: null, setup: [], checks: [], integration_checks: [] }, contracts: [],
    tickets: [{ id: 'T1', title: 'a', kind: 'work', wave: 1, scope: 'x', owns: ['a/'], reads: [], contracts: [], done_when: ['ok'] }],
  }));
  assert.equal(runCli(['propose', join(drafts, 'plan.json')], { cwd: root }).code, 0);
  assert.equal(runCli(['approve'], { cwd: root }).code, 0);
  assert.equal(runCli(['start-ticket', 'T1'], { cwd: root }).code, 0);
  const wt = join(root, '.claude', 'worktrees', 'agent-x');
  sh(root, ['worktree', 'add', '-q', '-b', 'worktree-agent-x', wt]);
  return { root, id, wt, drafts };
}

test('regression #4: orchestrator-only commands refuse with exit 3 inside a linked worktree', () => {
  const { root, id, wt, drafts } = approvedWithWorktree();
  const f = join(drafts, 'plan.json');
  const cmds = [
    ['init', '--title', 'x'], ['approve'], ['propose', f], ['revise-charter', f], ['start-ticket', 'T1'], ['set-agent', 'T1', '--agent', 'z'],
    ['answer', 'T1', '--text', 'x'], ['add-ticket', '--origin', 'handback', '--file', f], ['merge', 'T1'], ['merge-continue'], ['merge-abort', 'T1'],
    ['next-wave'], ['verify-result', '--passed', 'true'], ['review', '--file', f], ['finish'], ['abort'], ['mark-failed', 'T1', '--reason', 'x'],
  ];
  const before = readFileSync(join(stateDir(root), 'runs', id, 'run.json'), 'utf8');
  for (const args of cmds) {
    for (const cwd of [wt, join(wt, 'a')]) {
      mkdirSync(join(wt, 'a'), { recursive: true });
      const r = runCli(args, { cwd });
      assert.equal(r.code, 3, `${args[0]} from ${cwd}: ${r.stderr}`);
      assert.match(r.stderr, /worktree/, args[0]);
    }
  }
  assert.equal(readFileSync(join(stateDir(root), 'runs', id, 'run.json'), 'utf8'), before);
  assert.equal(activeRunId(root), id);
  // worker-usable commands still work from the worktree
  for (const args of [['claim', 'T1'], ['brief', 'T1'], ['show'], ['show', '--run'], ['status'], ['proposal'], ['check-diff', 'T1']]) {
    const r = runCli(args, { cwd: wt });
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
  }
  // and the orchestrator commands still work from the main checkout (and its subdirectories)
  mkdirSync(join(root, 'sub'), { recursive: true });
  assert.equal(runCli(['set-agent', 'T1', '--agent', 'z'], { cwd: join(root, 'sub') }).code, 0);
});
