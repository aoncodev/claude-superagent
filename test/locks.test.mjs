import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRepo } from './helpers.mjs';
import { createRun, loadTickets, saveTicket, stateDir, updateTicket } from '../lib/state.mjs';

const STATE_URL = new URL('../lib/state.mjs', import.meta.url).href;

const scriptDir = mkdtempSync(join(tmpdir(), 'superagent-lock-child-'));
const CHILD = join(scriptDir, 'child.mjs');
writeFileSync(CHILD, [
  `import { updateTicket } from ${JSON.stringify(STATE_URL)};`,
  "const [root, runId, ticketId, field, value] = process.argv.slice(2);",
  'const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
  'updateTicket(root, runId, ticketId, (ticket) => { sleep(30); ticket[field] = value; });',
  '',
].join('\n'));

function setup() {
  const root = makeRepo();
  const run = createRun(root, { title: 'Locks' });
  saveTicket(root, run.id, { id: 'T1', title: 'One', kind: 'work', wave: 1, status: 'planned', a: null, b: null });
  return { root, run };
}

const lockFile = (root, run) => join(stateDir(root), 'runs', run.id, 'tickets', 'T1.lock');

function spawnWriter(root, run, field, value) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, root, run.id, 'T1', field, value], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

test('two processes updating the same ticket concurrently keep both fields, 20 times', async () => {
  const { root, run } = setup();
  for (let i = 0; i < 20; i++) {
    saveTicket(root, run.id, { id: 'T1', title: 'One', kind: 'work', wave: 1, status: 'planned', a: null, b: null });
    const [left, right] = await Promise.all([
      spawnWriter(root, run, 'a', `left-${i}`),
      spawnWriter(root, run, 'b', `right-${i}`),
    ]);
    assert.equal(left.code, 0, left.stderr);
    assert.equal(right.code, 0, right.stderr);
    const t = loadTickets(root, run.id).find((x) => x.id === 'T1');
    assert.deepEqual({ a: t.a, b: t.b }, { a: `left-${i}`, b: `right-${i}` }, `iteration ${i}`);
  }
  assert.equal(existsSync(lockFile(root, run)), false, 'no lock left behind');
});

test('a stale ticket lock is removed and the update proceeds', () => {
  const { root, run } = setup();
  const lock = lockFile(root, run);
  writeFileSync(lock, 'a dead process\n');
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const t = updateTicket(root, run.id, 'T1', (ticket) => { ticket.status = 'running'; }, { staleMs: 50, timeoutMs: 1000 });
  assert.equal(t.status, 'running');
  assert.equal(existsSync(lock), false);
  assert.equal(loadTickets(root, run.id)[0].status, 'running');
});

test('a fresh lock that never clears makes updateTicket time out without touching the ticket', () => {
  const { root, run } = setup();
  const lock = lockFile(root, run);
  writeFileSync(lock, 'held by someone else\n');
  assert.throws(
    () => updateTicket(root, run.id, 'T1', (ticket) => { ticket.status = 'running'; }, { timeoutMs: 100, staleMs: 60_000 }),
    (e) => e.name === 'StateError' && /lock/.test(e.message),
  );
  assert.equal(loadTickets(root, run.id)[0].status, 'planned');
  assert.ok(existsSync(lock), 'a lock this process did not create is left alone');
});

test('a throwing mutator leaves the ticket untouched and releases the lock', () => {
  const { root, run } = setup();
  const lock = lockFile(root, run);
  assert.throws(
    () => updateTicket(root, run.id, 'T1', (ticket) => { ticket.status = 'running'; throw new Error('abort write'); }),
    /abort write/,
  );
  assert.equal(existsSync(lock), false, 'the lock is removed even when the mutator throws');
  assert.equal(loadTickets(root, run.id)[0].status, 'planned', 'nothing was written');
  assert.equal(updateTicket(root, run.id, 'T1', (ticket) => { ticket.status = 'running'; }).status, 'running');
});
