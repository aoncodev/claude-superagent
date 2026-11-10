#!/usr/bin/env node
// Harness-owned acceptance test for one eval arm: does the app the arm built satisfy the bookmarks
// HTTP contract? This is deliberately independent of the arm's own tests, so a repository with
// `"test": "true"` cannot pass it.
//
//   node evals/accept.mjs <repo>
//
// The contract:
//   start   `npm start` (package.json scripts.start) or, without a start script, `node server.js`
//   listen  on process.env.PORT
//   store   bookmarks durably (SQLite or JSON file); BOOKMARKS_DB names the database file path
//   POST    /api/bookmarks {url, title} -> 200 or 201, saved
//   GET     /api/bookmarks -> 200 JSON array, each item has url and title, newest first
//
// The test starts the app on a free port with a temp database path, waits for it, posts two
// bookmarks, checks the list, then stops the app. On failure it prints a clear reason (no start
// command, did not start, timeout, wrong status, wrong order, missing field) plus the app's output
// tail, and exits 1; it exits 0 on pass.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const START_TIMEOUT_MS = 20000;
const HTTP_TIMEOUT_MS = 5000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const ORDER_DELAY_MS = 1100;
const KILL_GRACE_MS = 2000;
const OUTPUT_LIMIT = 20000;
const TAIL_CHARS = 1200;

/** The two bookmarks posted by the contract test; they must come back newest first. */
export const CONTRACT_BOOKMARKS = [
  { url: 'https://example.com/older-bookmark', title: 'Older bookmark' },
  { url: 'https://example.com/newer-bookmark', title: 'Newer bookmark' },
];

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const tail = (text, maxChars = TAIL_CHARS) => {
  const s = String(text ?? '').trim();
  return s.length <= maxChars ? s : `…${s.slice(-maxChars)}`;
};

function appendOutput(sink, chunk) {
  sink.text = `${sink.text}${String(chunk)}`.slice(-OUTPUT_LIMIT);
}

function readPackageJson(repo) {
  const file = join(repo, 'package.json');
  if (!existsSync(file)) return { pkg: null, error: null };
  try {
    return { pkg: JSON.parse(readFileSync(file, 'utf8')), error: null };
  } catch (e) {
    return { pkg: null, error: `package.json is not valid JSON: ${e.message}` };
  }
}

/** The command that starts the app: `npm start` if package.json has scripts.start, else `node server.js`. */
export function startCommandFor(repo, pkg) {
  const script = pkg?.scripts?.start;
  if (typeof script === 'string' && script.trim()) return { command: 'npm', args: ['start'], label: 'npm start' };
  if (existsSync(join(repo, 'server.js'))) return { command: process.execPath, args: ['server.js'], label: 'node server.js' };
  return null;
}

/** Runtime dependency names from package.json (dev-only dependencies are not installed). */
export function runtimeDependencies(pkg) {
  const deps = pkg?.dependencies;
  return deps && typeof deps === 'object' && !Array.isArray(deps) ? Object.keys(deps) : [];
}

/** Install runtime dependencies when the project declares some and node_modules is missing. */
function installRuntimeDependencies(repo, pkg) {
  if (!runtimeDependencies(pkg).length) return { ok: true, output: '' };
  if (existsSync(join(repo, 'node_modules'))) return { ok: true, output: 'node_modules already present; skipped npm install' };
  const r = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: repo, encoding: 'utf8', timeout: INSTALL_TIMEOUT_MS,
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`;
  return { ok: !r.error && r.status === 0, output };
}

/** Ask the operating system for a free TCP port, then release it for the app. */
function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });
}

/** One HTTP request with a timeout; never throws, returns the status/body or an error string. */
async function httpJson(url, options = {}) {
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON: the caller decides whether that matters */ }
    return { status: response.status, json, text, error: null };
  } catch (e) {
    return { status: null, json: null, text: '', error: e?.name === 'TimeoutError' ? `timed out after ${HTTP_TIMEOUT_MS} ms` : e.message };
  }
}

/** Wait until the app answers on its port; fail fast when it exits or the start command fails. */
async function waitForStart(url, childState) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (childState.error) return { ok: false, reason: `did not start: could not run the start command (${childState.error.message})` };
    if (childState.exited) {
      const { code, signal } = childState.exited;
      const how = signal ? `was killed by ${signal}` : `exited with code ${code}`;
      return { ok: false, reason: `did not start: the app ${how} before it listened on PORT` };
    }
    const probe = await httpJson(url);
    if (probe.error === null) return { ok: true };
    await sleep(150);
  }
  return { ok: false, reason: `did not start: timed out after ${START_TIMEOUT_MS} ms waiting for ${url}` };
}

/** Resolve true when the child exits within `ms`, false on timeout; clears the timer on exit. */
function waitForChildExit(child, ms) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolvePromise(false);
    }, ms);
    function onExit() {
      clearTimeout(timer);
      resolvePromise(true);
    }
    child.once('exit', onExit);
  });
}

/** Stop the app and everything it spawned (npm start spawns a child), then wait for it to die. */
async function stopChild(child) {
  if (!child) return;
  const kill = (signal) => {
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      try { child.kill(signal); } catch { /* already gone */ }
    }
  };
  if (child.exitCode === null && child.signalCode === null) {
    kill('SIGTERM');
    if (!(await waitForChildExit(child, KILL_GRACE_MS))) {
      kill('SIGKILL');
      await waitForChildExit(child, KILL_GRACE_MS);
    }
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

/**
 * Start the app left by one arm, exercise the contract against it and stop it.
 * Returns { pass, reason, output }. `output` is the app's captured stdout/stderr tail.
 */
export async function runAcceptance(repoArg) {
  const repo = resolve(repoArg);
  const failure = (reason, output = '') => ({ pass: false, reason, output });
  if (!existsSync(repo)) return failure(`repository not found: ${repo}`);
  const pkgRead = readPackageJson(repo);
  if (pkgRead.error) return failure(pkgRead.error);
  const start = startCommandFor(repo, pkgRead.pkg);
  if (!start) return failure('no start command: package.json has no non-empty scripts.start and there is no server.js');
  const install = installRuntimeDependencies(repo, pkgRead.pkg);
  if (!install.ok) return failure(`runtime dependencies did not install: ${tail(install.output)}`, install.output);

  const port = await freePort();
  const dbDir = mkdtempSync(join(tmpdir(), 'superagent-accept-db-'));
  const output = { text: '' };
  let child = null;
  try {
    child = spawn(start.command, start.args, {
      cwd: repo,
      env: { ...process.env, PORT: String(port), BOOKMARKS_DB: join(dbDir, 'bookmarks.db') },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => appendOutput(output, chunk));
    child.stderr.on('data', (chunk) => appendOutput(output, chunk));
    const childState = { exited: null, error: null };
    child.once('exit', (code, signal) => { childState.exited = { code, signal }; });
    child.once('error', (error) => { childState.error = error; });

    const baseUrl = `http://127.0.0.1:${port}`;
    const ready = await waitForStart(`${baseUrl}/api/bookmarks`, childState);
    if (!ready.ok) return failure(ready.reason, output.text);

    for (const [index, bookmark] of CONTRACT_BOOKMARKS.entries()) {
      if (index > 0) await sleep(ORDER_DELAY_MS);
      const posted = await httpJson(`${baseUrl}/api/bookmarks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bookmark),
      });
      if (posted.error) return failure(`POST /api/bookmarks failed: ${posted.error}`, output.text);
      if (posted.status !== 200 && posted.status !== 201) {
        return failure(`wrong status: POST /api/bookmarks returned HTTP ${posted.status}, expected 200 or 201`, output.text);
      }
    }

    const listed = await httpJson(`${baseUrl}/api/bookmarks`);
    if (listed.error) return failure(`GET /api/bookmarks failed: ${listed.error}`, output.text);
    if (listed.status !== 200) return failure(`wrong status: GET /api/bookmarks returned HTTP ${listed.status}, expected 200`, output.text);
    if (!Array.isArray(listed.json)) return failure('GET /api/bookmarks did not return a JSON array', output.text);

    const [older, newer] = CONTRACT_BOOKMARKS;
    const indexOf = (url) => listed.json.findIndex((item) => item && typeof item === 'object' && item.url === url);
    const olderIndex = indexOf(older.url);
    const newerIndex = indexOf(newer.url);
    if (olderIndex === -1) return failure(`missing bookmark: GET /api/bookmarks did not include ${older.url}`, output.text);
    if (newerIndex === -1) return failure(`missing bookmark: GET /api/bookmarks did not include ${newer.url}`, output.text);
    for (const [bookmark, index] of [[older, olderIndex], [newer, newerIndex]]) {
      for (const field of ['url', 'title']) {
        if (typeof listed.json[index][field] !== 'string' || !listed.json[index][field]) {
          return failure(`missing field: bookmark at index ${index} has no non-empty "${field}" string`, output.text);
        }
      }
      if (listed.json[index].title !== bookmark.title) {
        return failure(`wrong title: bookmark ${bookmark.url} has title ${JSON.stringify(listed.json[index].title)}, expected ${JSON.stringify(bookmark.title)}`, output.text);
      }
    }
    if (!(newerIndex < olderIndex)) {
      return failure(`wrong order: expected newest bookmark ${newer.url} before older bookmark ${older.url} in GET /api/bookmarks`, output.text);
    }

    return { pass: true, reason: `${start.label} satisfies the bookmarks HTTP contract: POST saves, GET lists both newest first`, output: output.text };
  } finally {
    await stopChild(child);
    rmSync(dbDir, { recursive: true, force: true });
  }
}

async function main(argv) {
  const repo = argv.find((arg) => !arg.startsWith('-'));
  if (!repo) {
    process.stderr.write('usage: node evals/accept.mjs <repo>\n');
    process.exitCode = 1;
    return;
  }
  const result = await runAcceptance(repo);
  process.stdout.write(`acceptance ${result.pass ? 'PASS' : 'FAIL'}: ${result.reason} (${resolve(repo)})\n`);
  if (!result.pass && result.output) process.stdout.write(`--- app output tail ---\n${tail(result.output)}\n`);
  process.exitCode = result.pass ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`acceptance error: ${e?.stack ?? e?.message ?? e}\n`);
    process.exitCode = 1;
  });
}
