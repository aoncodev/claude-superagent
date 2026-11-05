import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'agents');

/** Minimal frontmatter parser: `key: value` lines between the first two `---` lines. */
function parse(file) {
  const text = readFileSync(join(AGENTS, file), 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, `${file} must start with --- frontmatter ---`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2] };
}

test('worker: frontmatter and required rules', () => {
  const { meta, body } = parse('worker.md');
  assert.equal(meta.name, 'worker');
  assert.ok(meta.description);
  assert.equal(meta.model, 'inherit');
  assert.equal(meta.tools, undefined, 'worker inherits all tools');
  for (const s of ['superagent claim', 'superagent brief', 'superagent report', 'handbacks', '100 words', 'exactly one']) {
    assert.ok(body.includes(s), `worker.md must mention ${s}`);
  }
});

test('fidelity-reviewer: frontmatter and required rules', () => {
  const { meta, body } = parse('fidelity-reviewer.md');
  assert.equal(meta.name, 'fidelity-reviewer');
  assert.ok(meta.description);
  assert.equal(meta.model, 'inherit');
  assert.equal(meta.tools, 'Read, Grep, Glob, Bash, Write');
  for (const s of ['superagent review', 'must not read the tickets']) {
    assert.ok(body.includes(s), `fidelity-reviewer.md must mention ${s}`);
  }
});
