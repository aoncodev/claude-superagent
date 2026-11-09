import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, runCli } from './helpers.mjs';
import {
  activeRunId, loadEvents, loadRun, saveRun, saveTicket, writeReport, writeReview,
} from '../lib/state.mjs';

function setup() {
  const root = makeRepo();
  const r = runCli(['init', '--title', 'Meta'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  return { root, id: activeRunId(root) };
}

const mkTicket = (id, status, wave, title) => ({ id, title, kind: 'work', wave, status, attempts: 0 });

test('ruling appends a ruling event and prints the confirmation', () => {
  const { root, id } = setup();
  const r = runCli(['ruling', '--text', 'Use the existing auth library'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'ruling recorded');
  let rulings = loadEvents(root, id).filter((e) => e.type === 'ruling');
  assert.equal(rulings.length, 1);
  assert.equal(rulings[0].text, 'Use the existing auth library');
  assert.ok(!('ticket' in rulings[0]), 'no ticket unless --ticket is given');

  const t = runCli(['ruling', '--text', 'Retry T2', '--ticket', 'T2'], { cwd: root });
  assert.equal(t.code, 0, t.stderr);
  rulings = loadEvents(root, id).filter((e) => e.type === 'ruling');
  assert.equal(rulings.length, 2);
  assert.equal(rulings[1].text, 'Retry T2');
  assert.equal(rulings[1].ticket, 'T2');
});

test('ruling without text exits 1 and records nothing', () => {
  const { root, id } = setup();
  assert.equal(runCli(['ruling'], { cwd: root }).code, 1);
  assert.equal(runCli(['ruling', '--text', ''], { cwd: root }).code, 1);
  assert.equal(runCli(['ruling', '--text', '   '], { cwd: root }).code, 1);
  assert.equal(runCli(['ruling', '--ticket', 'T1'], { cwd: root }).code, 1);
  assert.equal(loadEvents(root, id).filter((e) => e.type === 'ruling').length, 0);
});

test('context prints the resume brief and exits 2 with no active run', () => {
  const none = runCli(['context'], { cwd: makeRepo() });
  assert.equal(none.code, 2);
  assert.match(none.stderr, /no active run/);

  const { root, id } = setup();
  const run = loadRun(root, id);
  run.phase = 'running';
  run.current_wave = 1;
  saveRun(root, run);
  saveTicket(root, id, mkTicket('T1', 'merged', 1, 'API'));
  saveTicket(root, id, mkTicket('T2', 'running', 1, 'UI'));
  saveTicket(root, id, mkTicket('T3', 'planned', 2, 'Docs'));
  saveTicket(root, id, mkTicket('T4', 'blocked', 1, 'Auth'));
  writeReport(root, id, 'T4', 1, {
    status: 'blocked', summary: 'Need a decision.', progress: 'Half done.',
    question: { text: 'JWT or sessions?' }, checks: [],
  });
  writeReview(root, id, { unmet: [{ item: 'a', evidence: 'x' }], extras: [], contradictions: [] });
  writeReview(root, id, {
    unmet: [{ item: 'a', evidence: 'x' }, { item: 'b', evidence: 'y' }],
    extras: [{ item: 'c', evidence: 'z' }],
    contradictions: [],
  });

  const r = runCli(['context'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.stdout.trimEnd().split('\n'), [
    `run: ${id} · Meta`,
    'phase: running · wave: 1 · parallelism: 4',
    'branch: - (base -)',
    'tickets: 4 (1 merged, 1 running, 1 planned, 1 blocked, 0 failed, 0 dropped)',
    'T2 running wave 1 · UI',
    'T4 blocked wave 1 · Auth',
    'T3 planned wave 2 · Docs',
    'blocked: T4: JWT or sessions?',
    'fidelity: 2 unmet, 1 extras, 0 contradictions',
    'next: ask T4',
  ]);
});

test('context prints none for fidelity with no review and the next launch line', () => {
  const { root, id } = setup();
  const run = loadRun(root, id);
  run.phase = 'running';
  run.current_wave = 1;
  saveRun(root, run);
  saveTicket(root, id, mkTicket('T1', 'planned', 1, 'API'));
  const r = runCli(['context'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines.at(-2), 'fidelity: none');
  assert.equal(lines.at(-1), 'next: launch T1');
  assert.equal(lines[3], 'tickets: 1 (0 merged, 0 running, 1 planned, 0 blocked, 0 failed, 0 dropped)');
});
