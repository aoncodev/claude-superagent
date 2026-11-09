// v0.2 health commands: doctor, audit, stats. Owned by the health workstream.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateError, UsageError } from '../errors.mjs';
import { dirtyFiles, git, mainRoot } from '../git.mjs';
import { decideBash, decideFileWrite } from '../guard.mjs';
import {
  activeRunId, appendEvent, loadEvents, loadRun, loadTickets,
} from '../state.mjs';

const pluginRootFromModule = () => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const LAYOUT_FILES = ['hooks/hooks.json', 'hooks/guard-files.mjs', 'hooks/guard-bash.mjs', 'hooks/guard-read.mjs', 'bin/superagent'];
const WRITE_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit';

function pluginLayout(pluginRoot) {
  const missing = LAYOUT_FILES.filter((f) => !existsSync(join(pluginRoot, f)));
  if (missing.length) return { ok: false, detail: `missing ${missing.join(', ')}` };
  const bin = join(pluginRoot, 'bin', 'superagent');
  if ((statSync(bin).mode & 0o111) === 0) return { ok: false, detail: `${bin} is not executable` };
  return { ok: true };
}

/** Absolute path of the guard script a hook command runs, or null. */
function guardScript(command, pluginRoot) {
  const quoted = /["']([^"']+)["']/.exec(command);
  const raw = quoted ? quoted[1] : String(command).trim().split(/\s+/).filter((t) => !t.startsWith('-')).at(-1);
  if (!raw) return null;
  const expanded = raw.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
  return expanded.startsWith('/') ? expanded : resolve(pluginRoot, expanded);
}

function hooksRegistrations(pluginRoot) {
  const file = join(pluginRoot, 'hooks', 'hooks.json');
  if (!existsSync(file)) return { ok: false, detail: `missing ${file}` };
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, detail: `invalid JSON in ${file}: ${e.message}` };
  }
  const entries = data?.hooks?.PreToolUse;
  if (!Array.isArray(entries)) return { ok: false, detail: 'hooks.json has no hooks.PreToolUse array' };
  const problems = [];
  for (const matcher of [WRITE_MATCHER, 'Bash']) {
    const entry = entries.find((e) => e?.matcher === matcher);
    if (!entry) { problems.push(`no PreToolUse matcher for ${matcher}`); continue; }
    const commands = (Array.isArray(entry.hooks) ? entry.hooks : []).map((h) => h?.command).filter((c) => typeof c === 'string');
    if (!commands.length) { problems.push(`matcher ${matcher} has no command hooks`); continue; }
    for (const command of commands) {
      const script = guardScript(command, pluginRoot);
      if (!script || !existsSync(script)) problems.push(`matcher ${matcher} calls a missing guard script: ${command}`);
    }
  }
  return problems.length ? { ok: false, detail: problems.join('; ') } : { ok: true };
}

/** The three decision self-checks from the contract, run against this plugin's real lib/guard.mjs. */
function guardSelfTests(root) {
  const absPath = join(root, '.superagent', 'runs', 'x', 'charter.r1.md');
  const fileDecision = decideFileWrite({ absPath, root, run: null, tickets: [], worktree: null, lexicalWorktree: null });
  const guardedRun = { integration_branch: 'superagent/self-test', phase: 'running', allowed_actions: [] };
  const push = decideBash({ command: 'git push origin main', run: guardedRun });
  const status = decideBash({ command: 'git status', run: guardedRun });
  const lines = [
    fileDecision.allow
      ? { ok: false, name: 'guard denies writes to run state', detail: `decideFileWrite allowed ${absPath}` }
      : { ok: true, name: 'guard denies writes to run state' },
    push.allow
      ? { ok: false, name: 'guard denies git push for a guarded run', detail: 'decideBash allowed git push' }
      : { ok: true, name: 'guard denies git push for a guarded run' },
    status.allow
      ? { ok: true, name: 'guard allows git status' }
      : { ok: false, name: 'guard allows git status', detail: status.reason },
  ];
  return { ok: lines.every((l) => l.ok), lines };
}

/** Environment and guard self-checks. Returns { ok, lines } for both the CLI and tests. */
export function runDoctor({ pluginRoot = pluginRootFromModule(), cwd = process.cwd() } = {}) {
  const lines = [];
  let failures = 0;
  const pass = (name) => lines.push(`ok: ${name}`);
  const fail = (name, detail) => { failures += 1; lines.push(`FAIL: ${name}: ${detail}`); };
  const warn = (text) => lines.push(`warn: ${text}`);

  // Resolved once, up front: the guard self-checks judge run state under this checkout.
  let root = null;
  try { root = mainRoot(cwd); } catch { /* covered by the git check below */ }
  const stateRoot = root ?? resolve(cwd);

  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) pass(`node >= 22 (v${process.versions.node})`);
  else fail('node >= 22', `node v${process.versions.node} is older than 22`);

  const layout = pluginLayout(pluginRoot);
  if (layout.ok) pass(`plugin layout (${pluginRoot})`);
  else fail('plugin layout', layout.detail);

  const hooks = hooksRegistrations(pluginRoot);
  if (hooks.ok) pass('hooks.json registrations');
  else fail('hooks.json registrations', hooks.detail);

  const selfTests = guardSelfTests(stateRoot);
  for (const t of selfTests.lines) {
    if (t.ok) pass(t.name);
    else fail(t.name, t.detail);
  }

  if (root) pass(`git repository (${root})`);
  else warn('not inside a git repository (mainRoot does not resolve)');

  let active = null;
  let pointerError = null;
  try { active = activeRunId(stateRoot); } catch (e) { pointerError = e; }
  if (pointerError) fail('active run', `cannot read the active pointer: ${pointerError.message}`);
  else if (!active) warn('no active run');
  else {
    try { loadRun(stateRoot, active); pass(`active run loads (${active})`); }
    catch (e) { fail('active run', e.message); }
  }

  lines.push(failures ? `doctor: ${failures} check${failures === 1 ? '' : 's'} failed` : 'doctor: all checks passed');
  return { ok: failures === 0, lines };
}

function doctor(args, ctx) {
  const { ok, lines } = runDoctor({ cwd: ctx.cwd });
  for (const line of lines) console.log(line);
  if (!ok) process.exitCode = 1;
}

const short = (sha) => String(sha).slice(0, 12);

/** `<short sha> <subject>` for a commit, or the short sha when git cannot label it. */
function commitOneline(root, sha) {
  try { return git(['log', '--oneline', '-1', sha], root); } catch { return short(sha); }
}

/**
 * Integrity check of the main checkout against the approved run. Warnings (branch, unavailable
 * plugin) never fail; a moved base branch, a rogue commit on the integration branch, a dirty
 * working tree or a broken guard self-test does.
 */
function audit(args, ctx) {
  let resolved;
  try {
    resolved = ctx.resolveRun(args);
  } catch (e) {
    if (e instanceof UsageError) {
      console.log(`warn: not inside a git repository (${resolve(ctx.cwd)}); nothing to audit`);
      process.exitCode = 2;
      return;
    }
    throw e;
  }
  const { root, run } = resolved;
  if (!run.integration_branch || !run.base_sha || !run.base_branch) {
    throw new StateError(`cannot audit run ${run.id}: it has no integration branch yet; approve the plan and commit the base first`);
  }

  const checks = [];
  const failures = [];
  const failCheck = (name, detail, commits = []) => {
    checks.push({ name, ok: false, detail });
    failures.push({ name, detail, commits });
  };

  let tip = null;
  let gitError = null;
  try { tip = git(['rev-parse', run.base_branch], root); } catch (e) { gitError = e.message; }
  if (tip === run.base_sha) {
    checks.push({ name: 'base tip', ok: true });
  } else {
    let commits = [];
    if (tip) {
      try { commits = git(['log', '--oneline', `${run.base_sha}..${run.base_branch}`], root).split('\n').filter(Boolean); } catch (e) { gitError = gitError ?? e.message; }
    }
    const detail = gitError
      ? `cannot read ${run.base_branch}: ${gitError}`
      : `base branch ${run.base_branch} is at ${short(tip)}, but run.base_sha is ${short(run.base_sha)}`;
    failCheck('base tip', commits.length ? `${detail}; commits on ${run.base_branch} not in base_sha: ${commits.join('; ')}` : detail, commits);
  }

  // Every first-parent commit on the integration branch since the approved base must belong to a
  // merge this run recorded; anything else was committed outside a ticket, directly in the main checkout.
  const recorded = new Set(
    loadEvents(root, run.id)
      .filter((e) => e?.type === 'merged' && typeof e.sha === 'string' && e.sha !== '')
      .map((e) => e.sha),
  );
  let integrationCommits;
  try {
    integrationCommits = git(['rev-list', '--first-parent', `${run.base_sha}..${run.integration_branch}`], root)
      .split('\n')
      .filter(Boolean);
  } catch (e) {
    throw new StateError(`cannot audit run ${run.id}: cannot read the integration branch ${run.integration_branch} (${e.message})`);
  }
  const rogue = integrationCommits.filter((sha) => !recorded.has(sha));
  if (!rogue.length) {
    checks.push({ name: 'integration commits', ok: true });
  } else {
    const labels = rogue.map((sha) => commitOneline(root, sha));
    const plural = rogue.length === 1 ? '' : 's';
    failCheck(
      'integration commits',
      `${rogue.length} commit${plural} on ${run.integration_branch} not recorded in any merged event (made outside any ticket in the main checkout): ${labels.join('; ')}`,
      labels,
    );
  }

  let current = '';
  try { current = git(['branch', '--show-current'], root); } catch { /* detached or unreadable */ }
  if (current !== run.integration_branch) {
    console.log(`warn: main checkout is on ${current || 'a detached HEAD'}, expected ${run.integration_branch} (the orchestrator checks it out during runs)`);
  }
  try {
    const dirty = dirtyFiles(root);
    if (!dirty.length) {
      checks.push({ name: 'clean tree', ok: true });
    } else {
      const shown = `${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}`;
      failCheck('clean tree', `${dirty.length} uncommitted change${dirty.length === 1 ? '' : 's'}: ${shown}`);
    }
  } catch (e) {
    failCheck('clean tree', `cannot check the working tree: ${e.message}`);
  }

  const layout = pluginLayout(pluginRootFromModule());
  if (!layout.ok) {
    console.log(`warn: guard self-check skipped: plugin layout is missing (${layout.detail})`);
  } else {
    const selfTests = guardSelfTests(root);
    const detail = selfTests.lines.filter((l) => !l.ok).map((l) => `${l.name}: ${l.detail}`).join('; ');
    if (selfTests.ok) checks.push({ name: 'guard self-tests', ok: true });
    else failCheck('guard self-tests', detail);
  }

  const ok = checks.every((c) => c.ok);
  appendEvent(root, run.id, 'audited', { ok, checks });
  if (ok) {
    console.log('audit ok');
    return;
  }
  console.log('audit FAILED');
  for (const f of failures) {
    console.log(`FAIL: ${f.name}: ${f.detail}`);
    for (const commit of f.commits) console.log(`  ${commit}`);
  }
  if (failures.some((f) => f.name === 'base tip')) {
    console.log('The base branch moved after approval: a worker or a command changed it. Inspect the commits above; the approved base is no longer the one the run started from.');
  }
  if (failures.some((f) => f.name === 'integration commits')) {
    console.log(`A commit outside any ticket was made in the main checkout on ${run.integration_branch}: inspect the commits above and remove them from the integration branch, then re-run audit.`);
  }
  process.exitCode = 3;
}

const countBy = (tickets, key) => {
  const out = {};
  for (const t of tickets) {
    const k = t[key] ?? 'unknown';
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
};

/** Derived run metrics (the `stats --json` shape). Pure: takes what the caller loaded. */
export function computeStats(run, tickets, events) {
  const finished = events.filter((e) => e?.type === 'finished').at(-1) ?? null;
  const finishedAt = run.phase === 'done' ? finished?.ts ?? null : null;
  const created = Date.parse(run.created_at);
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  const duration = Number.isFinite(created) && Number.isFinite(end) ? Math.max(0, Math.round((end - created) / 1000)) : null;
  return {
    id: run.id,
    title: run.title,
    phase: run.phase,
    wave: run.current_wave ?? null,
    parallelism: run.parallelism ?? null,
    created_at: run.created_at ?? null,
    finished_at: finishedAt,
    duration_seconds: duration,
    tickets_total: tickets.length,
    tickets_by_status: countBy(tickets, 'status'),
    tickets_by_origin: countBy(tickets, 'origin'),
    attempts: tickets.reduce((n, t) => n + (Number.isInteger(t.attempts) ? t.attempts : 0), 0),
    blocked_events: events.filter((e) => e?.type === 'ticket_reported' && e.status === 'blocked').length,
    merge_conflicts: events.filter((e) => e?.type === 'merge_conflict').length,
    merges: events.filter((e) => e?.type === 'merged').length,
    verifications: events.filter((e) => e?.type === 'verified').length,
    reviews: events.filter((e) => e?.type === 'reviewed').length,
    fix_waves_used: run.fix_waves_used ?? { fix: 0, fidelity: 0 },
    events_total: events.length,
  };
}

const fmtCounts = (map) => Object.entries(map).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';

function stats(args, ctx) {
  const { root, run } = ctx.resolveRun(args);
  const data = computeStats(run, loadTickets(root, run.id), loadEvents(root, run.id));
  if (args.flags.json === true) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const fix = data.fix_waves_used ?? {};
  const rows = [
    ['run', data.id],
    ['title', data.title],
    ['phase', data.phase],
    ['wave', data.wave ?? '-'],
    ['parallelism', data.parallelism ?? '-'],
    ['created', data.created_at ?? '-'],
    ['finished', data.finished_at ?? '-'],
    ['duration', data.duration_seconds === null ? '-' : `${data.duration_seconds}s`],
    ['tickets', `${data.tickets_total} (${fmtCounts(data.tickets_by_status)})`],
    ['by origin', fmtCounts(data.tickets_by_origin)],
    ['attempts', data.attempts],
    ['blocked events', data.blocked_events],
    ['merge conflicts', data.merge_conflicts],
    ['merges', data.merges],
    ['verifications', data.verifications],
    ['reviews', data.reviews],
    ['fix waves', `fix ${fix.fix ?? 0}, fidelity ${fix.fidelity ?? 0}`],
    ['events', data.events_total],
  ];
  const width = Math.max(...rows.map(([k]) => k.length)) + 1;
  for (const [k, v] of rows) console.log(`${`${k}:`.padEnd(width)} ${v}`);
}
stats.booleans = ['json'];

export default { doctor, audit, stats };
