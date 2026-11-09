#!/usr/bin/env node
// superagent eval harness. Dry run by default: prints the exact `claude -p ...` command and
// the independent acceptance command for each arm (single, waves, frontier). `--live` runs the
// arms and writes a JSON summary under evals/results/.
//
// Each arm run gets a fresh temporary git repository. By default `--live` uses the caller's real
// Claude Code login and configuration; `--isolated-config` instead points every run at a
// throwaway CLAUDE_CONFIG_DIR, which has no login and therefore requires ANTHROPIC_API_KEY.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { metricsForRun } from './metrics.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const ACCEPT = join(ROOT, 'evals', 'accept.mjs');
const RESULTS_DIR = join(ROOT, 'evals', 'results');
const AUTH_TIMEOUT_MS = 120000;
const ACCEPTANCE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_RUNS = 1;
const TAIL_CHARS = 600;

export const ARMS = ['single', 'waves', 'frontier'];

export const FIXTURE_IDEA = 'Build a small bookmarks web app: a page where I can save a link (URL + title) and see all saved links, newest first. Store them in SQLite. Add a GitHub Actions CI job that runs the tests on every push.';

const ARM_NOTES = {
  single: 'One direct agent, no superagent split: the baseline for elapsed time and verified completion.',
  waves: 'Superagent with wave barriers: the previous wave must be fully merged before the next wave launches.',
  frontier: 'Superagent with frontier scheduling: the shipped v0.2 skill, driven by `superagent next`.',
};

// Headless runs have no AskUserQuestion and nobody to approve anything. Every arm prompt says so
// explicitly, so the arms are compared on scheduling, not on how they handled a missing person.
export const PROMPT_PREAMBLE = [
  'This is a fully automated, headless eval run: no human is watching, and AskUserQuestion is unavailable. Do not ask the user anything and never wait for a person.',
  'The proposal is pre-approved exactly as shown: when the workflow asks for approval (in the superagent arms that is `superagent approve`), approve the proposal as-is and continue immediately.',
  'If a worker, reviewer or orchestration step asks a question or offers options, answer it yourself with the most conservative option: the one that changes the least, touches the fewest files, and preserves existing behaviour. Then continue.',
].join(' ');

const ARM_INSTRUCTIONS = {
  single: 'Do not use the superagent plugin for this. Implement the whole idea yourself in this checkout, with tests, and keep going until the project\'s checks pass.',
  waves: 'Use /superagent:start for the idea below. Follow the superagent:orchestrate skill, but use wave barriers instead of frontier scheduling: do not call `superagent next`; after each wave is fully merged, run `superagent next-wave` and only then launch the next wave. When a worker reports a blocked question, answer it with the most conservative option via `superagent answer <T> --text "<option>"` and continue.',
  frontier: 'Use /superagent:start for the idea below. Follow the shipped superagent:orchestrate skill exactly, including its `superagent next` loop (frontier scheduling). When a worker reports a blocked question, answer it with the most conservative option via `superagent answer <T> --text "<option>"` and continue.',
};

/** The prompt sent to `claude -p` for one arm: headless preamble, arm instruction, idea. */
export function promptFor(arm) {
  const instruction = ARM_INSTRUCTIONS[arm];
  if (!instruction) throw new Error(`unknown arm: ${arm}`);
  return `${PROMPT_PREAMBLE}\n\n${instruction}\n\nIdea: ${FIXTURE_IDEA}`;
}

/** The `claude` argv for one arm: the plugin is loaded from this checkout. */
export function claudeArgs(arm) {
  return ['-p', promptFor(arm), '--plugin-dir', ROOT, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'];
}

/** The minimal authentication probe: one prompt, no tools. */
export function authArgs() {
  return ['-p', 'reply ok'];
}

const quote = (s) => `'${String(s).split("'").join("'\\''")}'`;

/** The environment for a live call: the caller's own by default, throwaway CLAUDE_CONFIG_DIR when isolated. */
export function envFor(configDir) {
  return configDir ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : { ...process.env };
}

/** The exact shell line for one arm run, from its own repository. */
export function commandLine(arm, { repo, configDir = null } = {}) {
  const config = configDir ? `CLAUDE_CONFIG_DIR=${quote(configDir)} ` : '';
  return `(cd ${quote(repo)} && ${config}claude -p ${quote(promptFor(arm))} --plugin-dir ${quote(ROOT)} --dangerously-skip-permissions --output-format stream-json --verbose)`;
}

/** The exact shell line for the independent acceptance check of one arm run. */
export function acceptCommandLine(repo) {
  return `node ${quote(ACCEPT)} ${quote(repo)}`;
}

/** The exact shell line for the authentication pre-check (before any arm). */
export function authCommandLine({ configDir = null } = {}) {
  const config = configDir ? `CLAUDE_CONFIG_DIR=${quote(configDir)} ` : '';
  return `${config}claude -p 'reply ok'`;
}

/**
 * Build the run layout: one temp work root, one repository per arm run and, with
 * `isolated`, one throwaway config directory shared by every run. No `claude` call and no git
 * setup happens here; both are `--live` only.
 */
export function planEvaluation({ runs = DEFAULT_RUNS, isolated = false } = {}) {
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a positive integer, got ${JSON.stringify(runs)}`);
  const workRoot = mkdtempSync(join(tmpdir(), 'superagent-eval-'));
  const configDir = isolated ? join(workRoot, 'claude-config') : null;
  if (configDir) mkdirSync(configDir, { recursive: true });
  const arms = ARMS.map((arm) => {
    const repos = [];
    for (let i = 1; i <= runs; i++) repos.push(join(workRoot, runs === 1 ? arm : `${arm}-run${i}`));
    return { arm, repos };
  });
  return { workRoot, configDir, arms, runs, isolated };
}

function setupRepo(repo) {
  const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  mkdirSync(repo, { recursive: true });
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

/** Latest run id in a repository, or null. */
function latestRunId(repo) {
  try {
    const dir = join(repo, '.superagent', 'runs');
    const ids = readdirSync(dir).filter((id) => !id.startsWith('.')).sort();
    return ids.at(-1) ?? null;
  } catch {
    return null;
  }
}

/** metricsForRun for whatever run an arm left behind; null when there is none. */
function metricsOf(repo) {
  const runId = latestRunId(repo);
  if (!runId) return null;
  try {
    return metricsForRun(repo, runId);
  } catch (e) {
    return { error: e.message };
  }
}

const tail = (text, maxChars = TAIL_CHARS) => {
  const s = String(text ?? '').trim();
  return s.length <= maxChars ? s : `…${s.slice(-maxChars)}`;
};

/** Run the independent acceptance check `evals/accept.mjs <repo>` and capture its verdict. */
export function runAcceptance(repo) {
  const r = spawnSync(process.execPath, [ACCEPT, repo], { encoding: 'utf8', timeout: ACCEPTANCE_TIMEOUT_MS });
  return {
    pass: r.status === 0,
    exit_code: r.status,
    command: `node ${ACCEPT} ${repo}`,
    tail: tail(`${r.stdout ?? ''}${r.stderr ?? ''}`),
    error: r.error ? r.error.message : null,
  };
}

/** A minimal `claude -p "reply ok"` with the same environment/config the arms will use. */
export function authPrecheck({ configDir = null } = {}) {
  const r = spawnSync('claude', authArgs(), { env: envFor(configDir), encoding: 'utf8', timeout: AUTH_TIMEOUT_MS });
  if (r.error) return { ok: false, detail: r.error.message };
  if (r.status !== 0) {
    const detail = tail(`${r.stdout ?? ''}${r.stderr ?? ''}`, 400) || `exit ${r.status}`;
    return { ok: false, detail: `exit ${r.status}: ${detail}` };
  }
  return { ok: true };
}

/** Median of a non-empty numeric list; the mean of the two middle values for an even count. */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round2 = (n) => Math.round(n * 100) / 100;

// Fields aggregated across the runs of one arm. `fix_waves_used` is flattened because it is an
// object, not a scalar; any metric missing from a run (an unreadable run state) is skipped.
const METRIC_FIELDS = [
  ['duration_seconds', (m) => m.duration_seconds],
  ['tickets_total', (m) => m.tickets_total],
  ['attempts', (m) => m.attempts],
  ['blocked_events', (m) => m.blocked_events],
  ['merge_conflicts', (m) => m.merge_conflicts],
  ['merges', (m) => m.merges],
  ['verifications', (m) => m.verifications],
  ['reviews', (m) => m.reviews],
  ['events_total', (m) => m.events_total],
  ['human_interventions', (m) => m.human_interventions],
  ['fix_waves.fix', (m) => m.fix_waves_used?.fix],
  ['fix_waves.fidelity', (m) => m.fix_waves_used?.fidelity],
];

/** Mean of every readable metric across the runs of one arm, or null when none is present. */
export function meanMetrics(runs) {
  const present = runs.map((r) => r.metrics).filter((m) => m && typeof m === 'object' && !m.error);
  if (!present.length) return null;
  const out = {};
  for (const [key, read] of METRIC_FIELDS) {
    const values = present.map(read).filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (values.length) out[key] = round2(values.reduce((a, b) => a + b, 0) / values.length);
  }
  return Object.keys(out).length ? out : null;
}

/** Per-arm aggregate: wall-clock min/median/max, exit codes, acceptance pass rate, metric means. */
export function summarizeArm(arm, runs) {
  const walls = runs.map((r) => r.wall_clock_ms).filter((v) => typeof v === 'number' && Number.isFinite(v));
  const passed = runs.filter((r) => r.acceptance?.pass === true).length;
  return {
    arm,
    runs: runs.length,
    wall_clock_ms: walls.length ? { min: Math.min(...walls), median: median(walls), max: Math.max(...walls) } : null,
    exit_codes: runs.map((r) => r.exit_code),
    acceptance_passed: passed,
    acceptance_pass_rate: runs.length ? passed / runs.length : null,
    metrics_mean: meanMetrics(runs),
  };
}

const pct = (rate) => (rate === null || rate === undefined ? '-' : `${Math.round(rate * 100)}%`);
const wallText = (w) => (w ? `${w.min}/${w.median}/${w.max}` : '-');

function printTable(armResults) {
  const rows = [
    ['arm', 'runs', 'wall-clock ms (min/median/max)', 'exit codes', 'acceptance'],
    ...armResults.map(({ summary }) => [
      summary.arm,
      String(summary.runs),
      wallText(summary.wall_clock_ms),
      summary.exit_codes.map((c) => (c === null ? '-' : c)).join(',') || '-',
      `${summary.acceptance_passed}/${summary.runs} (${pct(summary.acceptance_pass_rate)})`,
    ]),
  ];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const format = (r) => r.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
  const lines = ['', 'results per arm:', ...rows.map(format)];

  const withMetrics = armResults.filter(({ summary }) => summary.metrics_mean);
  if (withMetrics.length) {
    const keys = METRIC_FIELDS.map(([key]) => key).filter((key) => withMetrics.some(({ summary }) => key in summary.metrics_mean));
    const metricRows = [
      ['arm', ...keys],
      ...withMetrics.map(({ summary }) => [summary.arm, ...keys.map((key) => String(summary.metrics_mean[key] ?? '-'))]),
    ];
    const metricWidths = metricRows[0].map((_, i) => Math.max(...metricRows.map((r) => r[i].length)));
    const metricFormat = (r) => r.map((cell, i) => cell.padEnd(metricWidths[i])).join('  ').trimEnd();
    lines.push('', 'metrics mean (superagent arms; runs whose state was readable):', ...metricRows.map(metricFormat));
  } else {
    lines.push('', 'metrics mean: no readable superagent run state (the superagent arms may have failed before creating a run)');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function dryRun(plan) {
  const { workRoot, configDir, arms, runs, isolated } = plan;
  const lines = [];
  lines.push('superagent eval — dry run (pass --live to execute)');
  lines.push('flags: --live executes the arms; --runs N repeats every arm (default 1); --isolated-config uses a throwaway CLAUDE_CONFIG_DIR');
  lines.push(`arms: ${ARMS.join(', ')}`);
  lines.push(`runs per arm: ${runs}`);
  lines.push(`fixture idea: ${FIXTURE_IDEA}`);
  lines.push(`config: ${isolated
    ? `throwaway CLAUDE_CONFIG_DIR (${configDir}); this has no login, so ANTHROPIC_API_KEY is required`
    : "the caller's real Claude Code login and configuration (pass --isolated-config for a throwaway CLAUDE_CONFIG_DIR, which requires ANTHROPIC_API_KEY)"}`);
  lines.push('pre-approval: every arm prompt pre-approves the proposal as shown and tells the orchestrator to answer any worker question with the most conservative option (headless runs have no AskUserQuestion).');
  lines.push(`work root: ${workRoot}`);
  lines.push('');
  lines.push(`auth pre-check (before any arm): ${authCommandLine({ configDir })}`);
  lines.push('');
  for (const { arm, repos } of arms) {
    lines.push(`# arm ${arm}`);
    lines.push(`#   ${ARM_NOTES[arm]}`);
    for (const [i, repo] of repos.entries()) {
      lines.push(`#   run ${i + 1}/${repos.length}: fresh git repository ${repo} (git init -q -b main, one initial commit)`);
      lines.push(commandLine(arm, { repo, configDir }));
      lines.push(`#   acceptance: ${acceptCommandLine(repo)}`);
    }
    lines.push('');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function liveRun(plan) {
  const { configDir, arms, isolated } = plan;
  const generatedAt = new Date().toISOString();
  const armResults = [];
  for (const { arm, repos } of arms) {
    process.stdout.write(`\n=== arm ${arm} ===\n${ARM_NOTES[arm]}\n`);
    const runs = [];
    for (const [index, repo] of repos.entries()) {
      const runNumber = index + 1;
      process.stdout.write(`--- ${arm} run ${runNumber}/${repos.length}: ${repo}\n`);
      try {
        setupRepo(repo);
      } catch (e) {
        runs.push({
          run: runNumber,
          repo,
          wall_clock_ms: null,
          exit_code: null,
          error: e.message,
          acceptance: { pass: false, exit_code: null, command: null, tail: '', error: e.message },
          metrics: null,
        });
        process.stdout.write(`--- ${arm} run ${runNumber}: setup failed: ${e.message}\n`);
        continue;
      }
      const started = Date.now();
      const spawned = spawnSync('claude', claudeArgs(arm), { cwd: repo, env: envFor(configDir), stdio: 'inherit' });
      const wallClockMs = Date.now() - started;
      const acceptance = runAcceptance(repo);
      const metrics = arm === 'single' ? null : metricsOf(repo);
      runs.push({
        run: runNumber,
        repo,
        wall_clock_ms: wallClockMs,
        exit_code: spawned.status,
        error: spawned.error ? spawned.error.message : null,
        acceptance,
        metrics,
      });
      process.stdout.write(`--- ${arm} run ${runNumber}: exit ${spawned.status ?? 'error'}, ${wallClockMs} ms, acceptance ${acceptance.pass ? 'PASS' : 'FAIL'}\n`);
    }
    armResults.push({ arm, runs, summary: summarizeArm(arm, runs) });
  }

  const summary = {
    generated_at: generatedAt,
    mode: 'live',
    fixture_idea: FIXTURE_IDEA,
    runs_per_arm: plan.runs,
    config: isolated ? 'isolated' : 'caller',
    auth_precheck: 'passed',
    work_root: plan.workRoot,
    arms: armResults,
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, `eval-${generatedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`\nresults: ${file}\n`);
  printTable(armResults);
  if (armResults.some(({ runs }) => runs.some((r) => r.exit_code !== 0))) process.exitCode = 1;
}

const USAGE = `usage: node evals/run.mjs [--live] [--runs N] [--isolated-config]

  (no flag)         dry run: print the exact commands, prompts and acceptance commands
  --live            execute every arm; needs an authenticated Claude Code CLI
  --runs N          repeat every arm N times (default 1)
  --isolated-config give live runs a throwaway CLAUDE_CONFIG_DIR (requires ANTHROPIC_API_KEY)`;

function parseArgs(argv) {
  const flags = { live: false, isolated: false, runs: DEFAULT_RUNS, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--live') flags.live = true;
    else if (arg === '--isolated-config') flags.isolated = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--runs' || arg.startsWith('--runs=')) {
      const value = arg === '--runs' ? argv[++i] : arg.slice('--runs='.length);
      const runs = Number(value);
      if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a positive integer, got ${JSON.stringify(value)}`);
      flags.runs = runs;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return flags;
}

function main(argv) {
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`superagent eval: ${e.message}\n\n${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  if (flags.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (!flags.live) {
    dryRun(planEvaluation(flags));
    return;
  }

  const version = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (version.error || version.status !== 0) {
    process.stderr.write('superagent eval: `claude` is not available on PATH; --live needs the Claude Code CLI\n');
    process.exitCode = 1;
    return;
  }
  if (flags.isolated && !process.env.ANTHROPIC_API_KEY) {
    process.stderr.write('superagent eval: --isolated-config needs ANTHROPIC_API_KEY: a throwaway CLAUDE_CONFIG_DIR has no login. Set ANTHROPIC_API_KEY, or omit --isolated-config to use your own Claude Code login.\n');
    process.exitCode = 1;
    return;
  }

  const plan = planEvaluation(flags);
  const auth = authPrecheck({ configDir: plan.configDir });
  if (!auth.ok) {
    process.stderr.write(`superagent eval: authentication pre-check failed (claude -p "reply ok"): ${auth.detail}\n`);
    process.stderr.write('superagent eval: --live needs an authenticated Claude Code CLI. Log in first (run `claude` or `claude /login`) so your real login is used, or set ANTHROPIC_API_KEY.\n');
    if (flags.isolated) {
      process.stderr.write('superagent eval: --isolated-config uses a throwaway CLAUDE_CONFIG_DIR, which has no login; set ANTHROPIC_API_KEY or omit --isolated-config.\n');
    }
    process.exitCode = 1;
    return;
  }
  liveRun(plan);
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) main(process.argv.slice(2));
