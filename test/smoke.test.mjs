import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { makeRepo } from './helpers.mjs';

test('makeRepo creates a committed repo', () => {
  const dir = makeRepo();
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^[0-9a-f]{40}$/);
});
