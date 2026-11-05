import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReport, wordCount } from '../lib/report.mjs';

function ready(over = {}) {
  return {
    status: 'ready',
    summary: 'Built the login form.',
    changed_files: ['src/ui/login.js'],
    branch: 'worktree-agent-1',
    commits: ['abc123'],
    checks: [{ command: 'npm test', passed: true }],
    handbacks: [],
    ...over,
  };
}

test('a 101-word summary is rejected', () => {
  const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  assert.deepEqual(validateReport(ready({ summary: words(100) })), []);
  const errors = validateReport(ready({ summary: words(101) }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /summary.*100/);
});

test('an empty summary is rejected', () => {
  assert.equal(validateReport(ready({ summary: '   ' })).length, 1);
});

test('a blocked report without a question is rejected', () => {
  const errors = validateReport(ready({ status: 'blocked', commits: [], progress: 'half done' }));
  assert.ok(errors.some((e) => /question/.test(e)), errors.join('\n'));
});

test('a blocked report with a question and progress is valid', () => {
  const r = ready({ status: 'blocked', commits: [], progress: 'half done', question: { text: 'Which db?', options: ['pg', 'sqlite'] } });
  assert.deepEqual(validateReport(r), []);
});

test('a blocked report with an empty question text is rejected', () => {
  const errors = validateReport(ready({ status: 'blocked', progress: 'x', question: { text: ' ' } }));
  assert.ok(errors.some((e) => /question\.text/.test(e)), errors.join('\n'));
});

test('a ready report with a question is rejected', () => {
  const errors = validateReport(ready({ question: { text: 'why?' } }));
  assert.ok(errors.some((e) => /question/.test(e)), errors.join('\n'));
});

test('a ready report with a failing check is rejected', () => {
  const errors = validateReport(ready({ checks: [{ command: 'npm test', passed: false }] }));
  assert.ok(errors.some((e) => /npm test/.test(e)), errors.join('\n'));
});

test('a ready report without commits is rejected', () => {
  const errors = validateReport(ready({ commits: [] }));
  assert.ok(errors.some((e) => /commits/.test(e)), errors.join('\n'));
});

test('a failed report without progress is rejected', () => {
  const errors = validateReport(ready({ status: 'failed', commits: [] }));
  assert.ok(errors.some((e) => /progress/.test(e)), errors.join('\n'));
  assert.deepEqual(validateReport(ready({ status: 'failed', commits: [], progress: 'done: A; remains: B' })), []);
});

test('an unknown status and malformed checks are rejected', () => {
  assert.ok(validateReport(ready({ status: 'done' })).some((e) => /status/.test(e)));
  assert.ok(validateReport(ready({ checks: 'ok' })).some((e) => /checks/.test(e)));
  assert.ok(validateReport(ready({ checks: [{ command: 'x' }] })).some((e) => /checks\[0\]/.test(e)));
  assert.deepEqual(validateReport(null), ['report must be a JSON object']);
});

test('a valid ready report has no errors', () => {
  assert.deepEqual(validateReport(ready()), []);
});

test('a dropped report needs only a summary', () => {
  assert.deepEqual(validateReport({ status: 'dropped', summary: 'Not needed.', checks: [] }), []);
});

test('wordCount counts whitespace tokens and each CJK character as one word', () => {
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount('  add   login\npage '), 3);
  // 登 录 页 面 add login: four CJK characters plus two tokens.
  assert.equal(wordCount('登录 页面 add login'), 6);
  assert.equal(wordCount('添加login页面'), 5);
});
