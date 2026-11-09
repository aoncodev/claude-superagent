import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { metricsForRun } from '../evals/metrics.mjs';
import { median, summarizeArm } from '../evals/run.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACCEPT = join(ROOT, 'evals', 'accept.mjs');

/** A hand-written run directory: run.json, two tickets and an event log. */
function fixtureRun() {
  const root = mkdtempSync(join(tmpdir(), 'superagent-eval-metrics-'));
  const id = '20260101-0000-bookmarks';
  const runDir = join(root, '.superagent', 'runs', id);
  mkdirSync(join(runDir, 'tickets'), { recursive: true });
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({
    id,
    title: 'Bookmarks app',
    phase: 'done',
    created_at: '2026-01-01T00:00:00.000Z',
    current_wave: 1,
    parallelism: 4,
    fix_waves_used: { fix: 1, fidelity: 0 },
  }));
  writeFileSync(join(runDir, 'tickets', 'T1.json'), JSON.stringify({ id: 'T1', status: 'merged', origin: 'plan', wave: 0, attempts: 2 }));
  writeFileSync(join(runDir, 'tickets', 'T2.json'), JSON.stringify({ id: 'T2', status: 'failed', origin: 'handback', wave: 1, attempts: 1 }));
  const events = [
    { ts: '2026-01-01T00:00:00.000Z', type: 'created' },
    { ts: '2026-01-01T00:00:10.000Z', type: 'approved' },
    { ts: '2026-01-01T00:00:20.000Z', type: 'ticket_reported', status: 'blocked' },
    { ts: '2026-01-01T00:00:30.000Z', type: 'answered' },
    { ts: '2026-01-01T00:00:40.000Z', type: 'ticket_reported', status: 'ready' },
    { ts: '2026-01-01T00:00:50.000Z', type: 'merge_conflict' },
    { ts: '2026-01-01T00:01:00.000Z', type: 'merged' },
    { ts: '2026-01-01T00:01:10.000Z', type: 'verified', passed: true },
    { ts: '2026-01-01T00:01:20.000Z', type: 'reviewed' },
    { ts: '2026-01-01T00:02:00.000Z', type: 'finished' },
  ];
  writeFileSync(join(runDir, 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return { root, id };
}

test('metricsForRun: stats shape plus human interventions on a hand-written run', () => {
  const { root, id } = fixtureRun();
  const m = metricsForRun(root, id);

  const keys = [
    'id', 'title', 'phase', 'wave', 'parallelism', 'created_at', 'finished_at', 'duration_seconds',
    'tickets_total', 'tickets_by_status', 'tickets_by_origin', 'attempts', 'blocked_events',
    'merge_conflicts', 'merges', 'verifications', 'reviews', 'fix_waves_used', 'events_total',
    'human_interventions',
  ];
  for (const k of keys) assert.ok(k in m, `metricsForRun must return ${k}`);

  assert.equal(m.id, id);
  assert.equal(m.title, 'Bookmarks app');
  assert.equal(m.phase, 'done');
  assert.equal(m.wave, 1);
  assert.equal(m.parallelism, 4);
  assert.equal(m.created_at, '2026-01-01T00:00:00.000Z');
  assert.equal(m.finished_at, '2026-01-01T00:02:00.000Z');
  assert.equal(m.duration_seconds, 120);
  assert.equal(m.tickets_total, 2);
  assert.deepEqual(m.tickets_by_status, { failed: 1, merged: 1 });
  assert.deepEqual(m.tickets_by_origin, { handback: 1, plan: 1 });
  assert.equal(m.attempts, 3);
  assert.equal(m.blocked_events, 1);
  assert.equal(m.merge_conflicts, 1);
  assert.equal(m.merges, 1);
  assert.equal(m.verifications, 1);
  assert.equal(m.reviews, 1);
  assert.deepEqual(m.fix_waves_used, { fix: 1, fidelity: 0 });
  assert.equal(m.events_total, 10);
  assert.equal(m.human_interventions, 2, 'approved + answered');
});

test('metricsForRun: finished_at is null and duration keeps counting while the run is open', async () => {
  const { root, id } = fixtureRun();
  const { loadRun, saveRun } = await import('../lib/state.mjs');
  const run = loadRun(root, id);
  run.phase = 'running';
  saveRun(root, run);
  const m = metricsForRun(root, id);
  assert.equal(m.finished_at, null);
  assert.ok(Number.isInteger(m.duration_seconds) && m.duration_seconds >= 120);
});

test('evals/run.mjs: the default is a dry run for every arm, with prompts and acceptance commands', () => {
  const r = spawnSync('node', [join(ROOT, 'evals', 'run.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.match(out, /dry run/i, 'the default is a dry run');
  assert.ok(out.includes('claude'), 'the command uses the claude CLI');
  assert.ok(out.includes('--plugin-dir'), 'the plugin is loaded from this checkout');
  assert.ok(out.includes('--dangerously-skip-permissions'));
  assert.ok(out.includes('--output-format'));
  assert.ok(out.includes('stream-json'));
  assert.ok(out.includes('--verbose'));
  assert.ok(out.includes(`claude -p 'reply ok'`), 'the auth pre-check is shown before any arm');
  assert.match(out, /pre-approved/i, 'the prompt pre-approves the proposal');
  assert.match(out, /most conservative option/i, 'worker questions are answered conservatively');
  assert.match(out, /AskUserQuestion/, 'the prompt explains that headless runs have no AskUserQuestion');
  assert.ok(!out.includes('=== arm'), 'a dry run does not execute an arm');
  for (const arm of ['single', 'waves', 'frontier']) {
    assert.ok(out.includes(`arm ${arm}`), `the dry run names the ${arm} arm`);
  }
  const acceptanceLines = out.split('\n').filter((line) => line.includes(`acceptance: node`) && line.includes('accept.mjs'));
  assert.equal(acceptanceLines.length, 3, 'each arm gets its own acceptance command');
});

test('evals/run.mjs: --runs N repeats every arm and shows all repetitions in the dry run', () => {
  const r = spawnSync('node', [join(ROOT, 'evals', 'run.mjs'), '--runs', '2'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.match(out, /runs per arm: 2/);
  assert.ok(out.includes('run 1/2'));
  assert.ok(out.includes('run 2/2'));
  const acceptanceLines = out.split('\n').filter((line) => line.includes('acceptance: node'));
  assert.equal(acceptanceLines.length, 6, 'two repetitions of three arms');
});

test('evals/run.mjs: --isolated-config documents the throwaway config dir and the API-key requirement', () => {
  const r = spawnSync('node', [join(ROOT, 'evals', 'run.mjs'), '--isolated-config'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('CLAUDE_CONFIG_DIR'));
  assert.ok(r.stdout.includes('ANTHROPIC_API_KEY'));
});

test('summarizeArm: wall-clock stats, exit codes, acceptance rate and metric means across runs', () => {
  const runs = [
    {
      wall_clock_ms: 1000,
      exit_code: 0,
      acceptance: { pass: true },
      metrics: {
        duration_seconds: 10, tickets_total: 4, attempts: 2, blocked_events: 0, merge_conflicts: 0,
        merges: 1, verifications: 2, reviews: 1, events_total: 10, human_interventions: 1,
        fix_waves_used: { fix: 0, fidelity: 0 },
      },
    },
    { wall_clock_ms: 3000, exit_code: 1, acceptance: { pass: false }, metrics: null },
    {
      wall_clock_ms: 9000,
      exit_code: 0,
      acceptance: { pass: true },
      metrics: {
        duration_seconds: 30, tickets_total: 6, attempts: 4, blocked_events: 2, merge_conflicts: 1,
        merges: 3, verifications: 4, reviews: 2, events_total: 20, human_interventions: 3,
        fix_waves_used: { fix: 1, fidelity: 0 },
      },
    },
  ];
  const summary = summarizeArm('frontier', runs);
  assert.equal(summary.arm, 'frontier');
  assert.equal(summary.runs, 3);
  assert.deepEqual(summary.wall_clock_ms, { min: 1000, median: 3000, max: 9000 });
  assert.deepEqual(summary.exit_codes, [0, 1, 0]);
  assert.equal(summary.acceptance_passed, 2);
  assert.equal(summary.acceptance_pass_rate, 2 / 3);
  // The run with no metrics is skipped, not treated as zeros.
  assert.equal(summary.metrics_mean.duration_seconds, 20);
  assert.equal(summary.metrics_mean.tickets_total, 5);
  assert.equal(summary.metrics_mean.attempts, 3);
  assert.equal(summary.metrics_mean.blocked_events, 1);
  assert.equal(summary.metrics_mean.merge_conflicts, 0.5);
  assert.equal(summary.metrics_mean.merges, 2);
  assert.equal(summary.metrics_mean.verifications, 3);
  assert.equal(summary.metrics_mean.reviews, 1.5);
  assert.equal(summary.metrics_mean.events_total, 15);
  assert.equal(summary.metrics_mean.human_interventions, 2);
  assert.equal(summary.metrics_mean['fix_waves.fix'], 0.5);
  assert.equal(summary.metrics_mean['fix_waves.fidelity'], 0);
});

test('summarizeArm: mean of two middle values for an even run count, null metrics when absent', () => {
  assert.equal(median([9000, 1000, 3000, 5000]), 4000);
  assert.equal(median([7]), 7);
  assert.equal(median([1, 4]), 2.5);
  const summary = summarizeArm('waves', [
    { wall_clock_ms: 100, exit_code: 0, acceptance: { pass: true }, metrics: null },
    { wall_clock_ms: 200, exit_code: 0, acceptance: { pass: true }, metrics: null },
  ]);
  assert.deepEqual(summary.wall_clock_ms, { min: 100, median: 150, max: 200 });
  assert.equal(summary.acceptance_pass_rate, 1);
  assert.equal(summary.metrics_mean, null);
});

/** Run evals/accept.mjs against a repository. */
function runAccept(repo) {
  return spawnSync('node', [ACCEPT, repo], { encoding: 'utf8' });
}

/** Create a temp repository for the acceptance tests, optionally with a package.json or Makefile. */
function makeAcceptRepo({ packageJson, makefile, init = true, commit = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'superagent-eval-accept-'));
  if (init) {
    const r = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    for (const [key, value] of [['user.email', 'eval@superagent.local'], ['user.name', 'superagent eval'], ['commit.gpgsign', 'false']]) {
      const c = spawnSync('git', ['config', key, value], { cwd: repo, encoding: 'utf8' });
      assert.equal(c.status, 0, c.stderr);
    }
  }
  writeFileSync(join(repo, 'README.md'), '# eval fixture\n');
  if (packageJson) writeFileSync(join(repo, 'package.json'), JSON.stringify(packageJson));
  if (makefile) writeFileSync(join(repo, 'Makefile'), makefile);
  if (commit) {
    const add = spawnSync('git', ['add', '.'], { cwd: repo, encoding: 'utf8' });
    assert.equal(add.status, 0, add.stderr);
    const c = spawnSync('git', ['commit', '-q', '-m', 'initial commit'], { cwd: repo, encoding: 'utf8' });
    assert.equal(c.status, 0, c.stderr);
  }
  return repo;
}

const hasNpm = () => spawnSync('npm', ['--version'], { encoding: 'utf8' }).status === 0;
const hasMake = () => spawnSync('make', ['--version'], { encoding: 'utf8' }).status === 0;

test('evals/accept.mjs: runs npm test when package.json has scripts.test (pass and fail)', (t) => {
  if (!hasNpm()) return t.skip('npm is not installed');
  const passing = makeAcceptRepo({ packageJson: { scripts: { test: 'node -e "process.exit(0)"' } } });
  const ok = runAccept(passing);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /acceptance PASS: npm test/);

  const failing = makeAcceptRepo({ packageJson: { scripts: { test: 'node -e "process.exit(1)"' } } });
  const bad = runAccept(failing);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /acceptance FAIL: npm test/);
  assert.match(bad.stdout, /output tail/);
});

test('evals/accept.mjs: runs make test when there is a Makefile and no npm test script', (t) => {
  if (!hasMake()) return t.skip('make is not installed');
  const repo = makeAcceptRepo({ makefile: 'test:\n\t@echo make-ok\n' });
  const r = runAccept(repo);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /acceptance PASS: make test/);
});

test('evals/accept.mjs: fails with "no test command" when the project defines none', () => {
  const repo = makeAcceptRepo();
  const r = runAccept(repo);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /acceptance FAIL/);
  assert.match(r.stdout, /no test command/);
});

test('evals/accept.mjs: requires a git repository with at least one commit', () => {
  const notGit = mkdtempSync(join(tmpdir(), 'superagent-eval-accept-'));
  const plain = runAccept(notGit);
  assert.equal(plain.status, 1);
  assert.match(plain.stdout, /not a git repository/);

  const empty = makeAcceptRepo({ init: true, commit: false });
  const noCommit = runAccept(empty);
  assert.equal(noCommit.status, 1);
  assert.match(noCommit.stdout, /no commits/);
});
