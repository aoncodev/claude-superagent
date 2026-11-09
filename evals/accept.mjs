#!/usr/bin/env node
// Independent acceptance check for one eval arm: does the repository the arm left behind actually
// pass its own project test command?
//
//   node evals/accept.mjs <repo>
//
// Requires a git repository with at least one commit. Runs `npm test` when package.json has a
// non-empty `scripts.test`, else `make test` when a Makefile exists, else fails with
// "no test command". Prints PASS/FAIL plus a short output tail; exits 0 on pass and 1 on fail.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const TAIL_CHARS = 800;
const TIMEOUT_MS = 30 * 60 * 1000;

const tail = (text, maxChars = TAIL_CHARS) => {
  const s = String(text ?? '').trim();
  return s.length <= maxChars ? s : `…${s.slice(-maxChars)}`;
};

function git(repo, args) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

/** The repository must exist, be a git repository and have at least one commit. */
export function checkRepo(repo) {
  if (!existsSync(repo)) return { ok: false, reason: `${repo} does not exist` };
  const inside = git(repo, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return { ok: false, reason: `${repo} is not a git repository` };
  const head = git(repo, ['rev-parse', '--verify', 'HEAD']);
  if (head.status !== 0) return { ok: false, reason: `${repo} has no commits` };
  return { ok: true };
}

/** The acceptance command for a repository, or null when the project defines no test command. */
export function testCommandFor(repo) {
  const pkgFile = join(repo, 'package.json');
  if (existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
      const script = pkg?.scripts?.test;
      if (typeof script === 'string' && script.trim()) return { kind: 'npm', command: 'npm', args: ['test'] };
    } catch {
      // An unreadable package.json is not a test command; fall through to the Makefile check.
    }
  }
  if (existsSync(join(repo, 'Makefile'))) return { kind: 'make', command: 'make', args: ['test'] };
  return null;
}

/** Run the acceptance check for one repository and return a structured verdict. */
export function runAcceptance(repoArg) {
  const repo = resolve(repoArg);
  const repoCheck = checkRepo(repo);
  if (!repoCheck.ok) {
    return { pass: false, command: null, exit_code: null, output: repoCheck.reason, error: null };
  }
  const testCommand = testCommandFor(repo);
  if (!testCommand) {
    return {
      pass: false,
      command: null,
      exit_code: null,
      output: 'no test command: package.json has no non-empty scripts.test and there is no Makefile',
      error: null,
    };
  }
  const command = `${testCommand.command} ${testCommand.args.join(' ')}`;
  const r = spawnSync(testCommand.command, testCommand.args, { cwd: repo, encoding: 'utf8', timeout: TIMEOUT_MS });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const timedOut = r.error?.code === 'ETIMEDOUT';
  return {
    pass: r.status === 0,
    command,
    exit_code: r.status,
    output: r.error ? `${r.error.message}\n${output}` : output,
    error: r.error ? (timedOut ? `timed out after ${TIMEOUT_MS} ms` : r.error.message) : null,
  };
}

function main(argv) {
  const repo = argv.find((arg) => !arg.startsWith('-'));
  if (!repo) {
    process.stderr.write('usage: node evals/accept.mjs <repo>\n');
    process.exitCode = 1;
    return;
  }
  const result = runAcceptance(repo);
  const status = result.pass ? 'PASS' : 'FAIL';
  process.stdout.write(`acceptance ${status}${result.command ? `: ${result.command}` : ''} (${resolve(repo)})\n`);
  if (!result.pass && result.command === null) process.stdout.write(`${tail(result.output)}\n`);
  if (result.command !== null) process.stdout.write(`--- output tail ---\n${tail(result.output) || '(no output)'}\n`);
  process.exitCode = result.pass ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) main(process.argv.slice(2));
