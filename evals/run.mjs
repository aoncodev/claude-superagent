#!/usr/bin/env node
// superagent eval harness. Dry run by default: prints the exact `claude -p ...` command for
// each arm (single, waves, frontier) on one fixture idea. `--live` executes them.
//
// Every arm runs in its own fresh temporary git repository, and all of them share one throwaway
// CLAUDE_CONFIG_DIR, so the user's real Claude Code configuration is never read or written.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { metricsForRun } from './metrics.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);

export const ARMS = ['single', 'waves', 'frontier'];

export const FIXTURE_IDEA = 'Build a small bookmarks web app: a page where I can save a link (URL + title) and see all saved links, newest first. Store them in SQLite. Add a GitHub Actions CI job that runs the tests on every push.';

const ARM_NOTES = {
  single: 'One direct agent, no superagent split: the baseline for elapsed time and verified completion.',
  waves: 'Superagent with wave barriers: the previous wave must be fully merged before the next wave launches.',
  frontier: 'Superagent with frontier scheduling: the shipped v0.2 skill, driven by `superagent next`.',
};

const ARM_INSTRUCTIONS = {
  single: 'Do not use the superagent plugin for this. Implement the whole idea yourself in this checkout, with tests, and keep going until the project\'s checks pass.',
  waves: 'Use /superagent:start for the idea below. Follow the superagent:orchestrate skill, but use wave barriers instead of frontier scheduling: do not call `superagent next`; after each wave is fully merged, run `superagent next-wave` and only then launch the next wave.',
  frontier: 'Use /superagent:start for the idea below. Follow the shipped superagent:orchestrate skill exactly, including its `superagent next` loop (frontier scheduling).',
};

/** The prompt sent to `claude -p` for one arm. */
export function promptFor(arm) {
  const instruction = ARM_INSTRUCTIONS[arm];
  if (!instruction) throw new Error(`unknown arm: ${arm}`);
  return `${instruction}\n\nIdea: ${FIXTURE_IDEA}`;
}

/** The `claude` argv for one arm: the plugin is loaded from this checkout. */
export function claudeArgs(arm) {
  return ['-p', promptFor(arm), '--plugin-dir', ROOT, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'];
}

const quote = (s) => `'${String(s).split("'").join("'\\''")}'`;

/** The exact shell line for one arm, from its own repository, with the throwaway config dir. */
export function commandLine(arm, { repo, configDir }) {
  return `(cd ${quote(repo)} && CLAUDE_CONFIG_DIR=${quote(configDir)} claude -p ${quote(promptFor(arm))} --plugin-dir ${quote(ROOT)} --dangerously-skip-permissions --output-format stream-json --verbose)`;
}

/**
 * Build the run layout: one temp work root, one throwaway config dir, one repository per arm.
 * No `claude` call and no git setup happens here; that is `--live` only.
 */
export function planEvaluation() {
  const workRoot = mkdtempSync(join(tmpdir(), 'superagent-eval-'));
  const configDir = join(workRoot, 'claude-config');
  mkdirSync(configDir, { recursive: true });
  const arms = ARMS.map((arm) => {
    const repo = join(workRoot, arm);
    mkdirSync(repo, { recursive: true });
    return { arm, repo };
  });
  return { workRoot, configDir, arms };
}

function setupRepo(repo) {
  const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  const first = git(['init', '-q', '-b', 'main']);
  if (first.status !== 0) throw new Error(`git init failed in ${repo}: ${first.stderr.trim()}`);
  git(['config', 'user.email', 'eval@superagent.local']);
  git(['config', 'user.name', 'superagent eval']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'README.md'), '# superagent eval fixture\n');
  git(['add', '.']);
  const commit = git(['commit', '-q', '-m', 'initial commit']);
  if (commit.status !== 0) throw new Error(`initial commit failed in ${repo}: ${commit.stderr.trim()}`);
}

/** Latest run id in a repo, or null. */
function latestRunId(repo) {
  try {
    const dir = join(repo, '.superagent', 'runs');
    const ids = readdirSync(dir).sort();
    return ids.at(-1) ?? null;
  } catch {
    return null;
  }
}

function metricsOf(repo) {
  const runId = latestRunId(repo);
  if (!runId) return null;
  try {
    return metricsForRun(repo, runId);
  } catch (e) {
    return { error: e.message };
  }
}

function dryRun({ workRoot, configDir, arms }) {
  const lines = [];
  lines.push('superagent eval — dry run (pass --live to execute)');
  lines.push(`arms: ${ARMS.join(', ')}`);
  lines.push(`fixture idea: ${FIXTURE_IDEA}`);
  lines.push('');
  lines.push(`Work root: ${workRoot}`);
  lines.push(`Throwaway CLAUDE_CONFIG_DIR for every arm: ${configDir}`);
  lines.push('Each arm runs in its own fresh git repository:');
  for (const { repo } of arms) lines.push(`  git init -q -b main ${quote(repo)} && git -C ${quote(repo)} commit --allow-empty -m 'initial commit'`);
  lines.push('');
  for (const { arm, repo } of arms) {
    lines.push(`# arm ${arm}`);
    lines.push(`#   ${ARM_NOTES[arm]}`);
    lines.push(`#   cwd: ${repo}`);
    lines.push(commandLine(arm, { repo, configDir }));
    lines.push('');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function liveRun({ configDir, arms }) {
  const results = [];
  for (const { arm, repo } of arms) {
    process.stdout.write(`\n=== arm ${arm} ===\n${ARM_NOTES[arm]}\n`);
    try {
      setupRepo(repo);
    } catch (e) {
      results.push({ arm, error: e.message, exit: null, duration_seconds: 0, metrics: null });
      continue;
    }
    const started = Date.now();
    const result = spawnSync('claude', claudeArgs(arm), {
      cwd: repo,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      stdio: 'inherit',
    });
    const duration = Math.round((Date.now() - started) / 1000);
    const entry = {
      arm,
      repo,
      exit: result.status,
      error: result.error ? result.error.message : null,
      duration_seconds: duration,
      metrics: metricsOf(repo),
    };
    results.push(entry);
    process.stdout.write(`\n--- arm ${arm}: exit ${entry.exit ?? 'error'}, ${duration}s, repo ${repo}\n`);
  }
  process.stdout.write(`\n${JSON.stringify(results, null, 2)}\n`);
  if (results.some((r) => r.exit !== 0)) process.exitCode = 1;
}

function main(argv) {
  const plan = planEvaluation();
  if (!argv.includes('--live')) {
    dryRun(plan);
    return;
  }
  const missing = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (missing.error || missing.status !== 0) {
    process.stderr.write('superagent eval: `claude` is not available on PATH; --live needs the Claude Code CLI\n');
    process.exitCode = 1;
    return;
  }
  liveRun(plan);
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) main(process.argv.slice(2));
