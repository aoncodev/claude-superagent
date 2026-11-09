import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { metricsForRun } from '../evals/metrics.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

test('evals/run.mjs: the dry run prints the claude commands for every arm', () => {
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
  assert.ok(/CLAUDE_CONFIG_DIR/.test(out), 'the command uses a throwaway CLAUDE_CONFIG_DIR');
  assert.ok(!out.includes('=== arm'), 'a dry run does not execute an arm');
  for (const arm of ['single', 'waves', 'frontier']) {
    assert.ok(out.includes(`arm ${arm}`), `the dry run names the ${arm} arm`);
  }
});
