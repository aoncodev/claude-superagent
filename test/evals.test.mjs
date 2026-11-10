import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { metricsForRun } from '../evals/metrics.mjs';
import { liveEnvironmentError, median, summarizeArm, USER_CONFIG_WARNING } from '../evals/run.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACCEPT = join(ROOT, 'evals', 'accept.mjs');
const RUN = join(ROOT, 'evals', 'run.mjs');

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

test('evals/run.mjs: the default is a dry run for every arm, with prompts, contract and acceptance commands', () => {
  const r = spawnSync('node', [RUN], { encoding: 'utf8' });
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
  // The fixture is the harness-owned HTTP contract, stated in every arm prompt.
  for (const contract of ['npm start', 'node server.js', 'process.env.PORT', 'BOOKMARKS_DB', 'POST /api/bookmarks', 'GET /api/bookmarks', 'newest first']) {
    assert.ok(out.includes(contract), `the fixture contract states ${contract}`);
  }
  const acceptanceLines = out.split('\n').filter((line) => line.includes('acceptance: node') && line.includes('accept.mjs'));
  assert.equal(acceptanceLines.length, 3, 'each arm gets its own acceptance command');
});

test('evals/run.mjs: --runs N repeats every arm and shows all repetitions in the dry run', () => {
  const r = spawnSync('node', [RUN, '--runs', '2'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.match(out, /runs per arm: 2/);
  assert.ok(out.includes('run 1/2'));
  assert.ok(out.includes('run 2/2'));
  const acceptanceLines = out.split('\n').filter((line) => line.includes('acceptance: node'));
  assert.equal(acceptanceLines.length, 6, 'two repetitions of three arms');
});

test('evals/run.mjs: the default dry run uses the isolated throwaway config and names the API-key requirement', () => {
  const r = spawnSync('node', [RUN], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('CLAUDE_CONFIG_DIR='));
  assert.ok(r.stdout.includes('ANTHROPIC_API_KEY'));
  assert.ok(r.stdout.includes('--user-config'), 'the opt-out is documented in the dry run');
});

test('evals/run.mjs: --user-config uses the caller config and warns that global plugins/hooks/CLAUDE.md apply', () => {
  const r = spawnSync('node', [RUN, '--user-config'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('CLAUDE_CONFIG_DIR='), 'no throwaway config dir in the commands');
  assert.match(r.stdout, /the caller's real Claude Code configuration/);
  assert.ok(r.stdout.includes('global plugins, hooks and CLAUDE.md'), 'the dry run states what --user-config loads');
  assert.ok(r.stdout.includes(`claude -p 'reply ok'`));
});

test('evals/run.mjs: --isolated-config is an accepted alias for the default isolated config', () => {
  const r = spawnSync('node', [RUN, '--isolated-config'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('CLAUDE_CONFIG_DIR='));
  assert.ok(r.stdout.includes('ANTHROPIC_API_KEY'));

  const both = spawnSync('node', [RUN, '--user-config', '--isolated-config'], { encoding: 'utf8' });
  assert.equal(both.status, 1);
  assert.match(both.stderr, /mutually exclusive/);
});

test('evals/run.mjs: live refuses the default isolated config without ANTHROPIC_API_KEY and accepts --user-config', () => {
  const missing = liveEnvironmentError({ userConfig: false, env: {} });
  assert.match(missing, /ANTHROPIC_API_KEY/);
  assert.match(missing, /--user-config/);
  assert.match(USER_CONFIG_WARNING, /global plugins, hooks and CLAUDE\.md/);
  assert.equal(liveEnvironmentError({ userConfig: false, env: { ANTHROPIC_API_KEY: 'test-key' } }), null);
  assert.equal(liveEnvironmentError({ userConfig: true, env: {} }), null);
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

// ---------------------------------------------------------------- harness-owned acceptance test

const hasNpm = () => spawnSync('npm', ['--version'], { encoding: 'utf8' }).status === 0;

/**
 * A tiny fixture bookmarks app: durable JSON store at BOOKMARKS_DB, listens on PORT, implements
 * POST/GET /api/bookmarks. `__CONFIG__` lets each test break one part of the contract.
 */
const CONTRACT_SERVER = `'use strict';
const http = require('node:http');
const fs = require('node:fs');
const CONFIG = __CONFIG__;
const dbPath = process.env.BOOKMARKS_DB || 'bookmarks.json';
function read() {
  try { return JSON.parse(fs.readFileSync(dbPath, 'utf8')); } catch { return []; }
}
function write(items) { fs.writeFileSync(dbPath, JSON.stringify(items)); }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'POST' && url.pathname === '/api/bookmarks') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const bookmark = JSON.parse(body);
      const items = read();
      items.push({ url: bookmark.url, title: bookmark.title, created_at: Date.now() });
      write(items);
      res.writeHead(CONFIG.postStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(bookmark));
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/bookmarks') {
    let items = read();
    if (CONFIG.newestFirst) items = items.slice().sort((a, b) => b.created_at - a.created_at);
    if (!CONFIG.includeTitle) items = items.map((item) => ({ url: item.url }));
    res.writeHead(CONFIG.getStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify(items));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});
server.listen(Number(process.env.PORT), '127.0.0.1');
`;

function contractServer(overrides = {}) {
  const config = { postStatus: 201, getStatus: 200, newestFirst: true, includeTitle: true, ...overrides };
  return CONTRACT_SERVER.replace('__CONFIG__', JSON.stringify(config));
}

/** A temp repository containing one fixture app; `server: null` means no app at all. */
function makeContractRepo({ server = contractServer(), packageJson } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'superagent-eval-accept-'));
  if (server !== null) writeFileSync(join(repo, 'server.js'), server);
  if (packageJson) writeFileSync(join(repo, 'package.json'), JSON.stringify(packageJson));
  return repo;
}

function runAccept(repo) {
  return spawnSync('node', [ACCEPT, repo], { encoding: 'utf8', timeout: 60000 });
}

test('evals/accept.mjs: passes an app that implements the bookmarks HTTP contract (node server.js)', () => {
  const repo = makeContractRepo();
  const r = runAccept(repo);
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /acceptance PASS/);
  assert.match(r.stdout, /satisfies the bookmarks HTTP contract/);
});

test('evals/accept.mjs: passes the same contract when the app is started with npm start', (t) => {
  if (!hasNpm()) return t.skip('npm is not installed');
  const repo = makeContractRepo({ packageJson: { name: 'eval-fixture', private: true, scripts: { start: 'node server.js' } } });
  const r = runAccept(repo);
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /acceptance PASS/);
});

test('evals/accept.mjs: fails when GET lists bookmarks oldest first (wrong order)', () => {
  const repo = makeContractRepo({ server: contractServer({ newestFirst: false }) });
  const r = runAccept(repo);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /acceptance FAIL/);
  assert.match(r.stdout, /wrong order/);
});

test('evals/accept.mjs: fails when a bookmark is missing the title field', () => {
  const repo = makeContractRepo({ server: contractServer({ includeTitle: false }) });
  const r = runAccept(repo);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /acceptance FAIL/);
  assert.match(r.stdout, /missing field/);
});

test('evals/accept.mjs: fails with a wrong-status reason when GET does not return 200', () => {
  const repo = makeContractRepo({ server: contractServer({ getStatus: 500 }) });
  const r = runAccept(repo);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /acceptance FAIL/);
  assert.match(r.stdout, /wrong status/);
});

test('evals/accept.mjs: fails with a clear reason when the app does not start', () => {
  const repo = makeContractRepo({ server: "'use strict';\nconsole.error('fixture: refusing to start');\nprocess.exit(1);\n" });
  const r = runAccept(repo);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /acceptance FAIL/);
  assert.match(r.stdout, /did not start/);
  assert.match(r.stdout, /exited with code 1/);
});

test('evals/accept.mjs: fails when the project has no start command', () => {
  const repo = makeContractRepo({ server: null });
  const r = runAccept(repo);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /acceptance FAIL/);
  assert.match(r.stdout, /no start command/);
});
