import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStatus } from '../lib/status.mjs';

const run = (over = {}) => ({ id: 'R1', phase: 'running', current_wave: 1, merging_ticket: null, ...over });
const tk = (id, status, wave = 1) => ({ id, title: id, status, wave });

test('healthy run prints exactly two lines starting with "Nothing needs you."', () => {
  const out = renderStatus(run(), [tk('T1', 'running'), tk('T2', 'merged'), tk('T3', 'planned', 2)], {}, []);
  const lines = out.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'Nothing needs you.');
  assert.equal(lines[1], 'Run R1 · running · wave 1/2 · 1 running · 1 merged · 1 planned');
});

test("a blocked ticket's question appears under \"Needs you:\" before the progress line", () => {
  const out = renderStatus(run(), [tk('T1', 'blocked')], { T1: { question: { text: 'JWT or sessions?' } } }, []);
  const lines = out.split('\n');
  assert.equal(lines[0], 'Needs you:');
  assert.match(lines[1], /^- T1.*JWT or sessions\?/);
  assert.match(lines.at(-1), /^Run R1 · /);
  assert.equal(lines.length, 3);
});

test('awaiting_approval lists "approve the split"', () => {
  const out = renderStatus(run({ phase: 'awaiting_approval', current_wave: null }), [tk('T1', 'planned')], {}, []);
  const lines = out.split('\n');
  assert.equal(lines[0], 'Needs you:');
  assert.match(lines[1], /approve the split/);
  assert.match(lines[2], /wave -\/1/);
});

test('failed and dropped tickets show the first sentence of the last report summary, or say there is none', () => {
  const out = renderStatus(
    run(),
    [tk('T1', 'failed'), tk('T2', 'dropped'), tk('T3', 'failed')],
    { T1: { summary: 'Tests fail on login. More detail here.' }, T2: { summary: 'Out of scope for this run' } },
    [],
  );
  assert.match(out, /- T1 failed: Tests fail on login\./);
  assert.doesNotMatch(out, /More detail/);
  assert.match(out, /- T2 dropped: Out of scope for this run/);
  assert.match(out, /- T3 failed: no report/);
});

test('merging with a conflict lists it; with no tickets the wave max is -', () => {
  const out = renderStatus(run({ phase: 'merging', merging_ticket: 'T4' }), [], {}, []);
  const lines = out.split('\n');
  assert.equal(lines[0], 'Needs you:');
  assert.match(lines[1], /T4/);
  assert.match(lines[1], /conflict/);
  assert.match(lines[2], /wave 1\/-/);
});

test('Needs you groups all blocked tickets before all failed/dropped ones, merge conflict last', () => {
  const out = renderStatus(
    run({ phase: 'merging', merging_ticket: 'T9' }),
    [tk('T1', 'failed'), tk('T2', 'blocked'), tk('T3', 'dropped'), tk('T4', 'blocked')],
    { T2: { question: { text: 'Q2?' } }, T4: { question: { text: 'Q4?' } } },
    [],
  );
  const items = out.split('\n').slice(1, -1).map((l) => l.match(/^- (T\d)/)[1]);
  assert.deepEqual(items, ['T2', 'T4', 'T1', 'T3', 'T9']);
});

test('a failed ticket marked failed shows the reason of its latest ticket_failed event, unless a newer report exists', () => {
  const ev = [
    { type: 'ticket_started', ticket: 'T1' },
    { type: 'ticket_failed', ticket: 'T1', reason: 'Worker ended twice without a report.' },
    { type: 'ticket_reported', ticket: 'T2', status: 'failed' },
    { type: 'ticket_failed', ticket: 'T3', reason: 'old reason' },
    { type: 'ticket_reported', ticket: 'T3', status: 'failed' },
  ];
  const out = renderStatus(
    run(),
    [tk('T1', 'failed'), tk('T2', 'failed'), tk('T3', 'failed')],
    { T2: { summary: 'Build broke.' }, T3: { summary: 'Newer report.' } },
    ev,
  );
  assert.match(out, /- T1 failed: Worker ended twice without a report\./);
  assert.match(out, /- T2 failed: Build broke\./);
  assert.match(out, /- T3 failed: Newer report\./);
  assert.doesNotMatch(out, /old reason/);
});

test('regression #17: failed and dropped tickets need the user only while the wave is running or merging', () => {
  const tickets = [tk('T1', 'failed'), tk('T2', 'dropped'), tk('T3', 'merged')];
  for (const phase of ['running', 'merging']) {
    const out = renderStatus(run({ phase }), tickets, {}, []);
    assert.match(out, /- T1 failed/, phase);
    assert.match(out, /- T2 dropped/, phase);
  }
  for (const phase of ['verifying', 'reviewing', 'done']) {
    const out = renderStatus(run({ phase }), tickets, {}, []);
    assert.equal(out.split('\n')[0], 'Nothing needs you.', phase);
  }
});
