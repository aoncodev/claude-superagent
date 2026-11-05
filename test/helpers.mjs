import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = join(ROOT, 'bin', 'superagent.mjs');

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/** Create a temp git repo (branch main, user configured). Commits one file when `commit` is true. */
export function makeRepo({ commit = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'superagent-test-')));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  if (commit) {
    writeFileSync(join(dir, 'README.md'), '# test\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'init']);
  }
  return dir;
}

function run(file, args, { cwd, input } = {}) {
  const r = spawnSync('node', [file, ...args], { cwd, input, encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Run the superagent CLI: node bin/superagent.mjs <args>. */
export function runCli(args, { cwd, input } = {}) {
  return run(CLI, args, { cwd, input });
}

/** Run a hook script with a JSON payload on stdin. */
export function runHook(script, payload) {
  return run(script, [], { input: JSON.stringify(payload) });
}
