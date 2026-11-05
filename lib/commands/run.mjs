import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { strFlag } from '../cli.mjs';
import { RefusalError, StateError, UsageError } from '../errors.mjs';
import { dirtyFiles, git, hasHead, mainRoot } from '../git.mjs';
import {
  PHASES, activeRunId, appendEvent, createRun, loadLastReport, loadRun, loadTickets, readCharter, saveRun, stateDir,
} from '../state.mjs';

const TERMINAL = ['done', 'aborted'];

function gitUserArgs(cwd) {
  const has = (key) => {
    try { return execFileSync('git', ['config', key], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== ''; } catch { return false; }
  };
  const args = ['-c', 'commit.gpgsign=false'];
  if (!has('user.name')) args.push('-c', 'user.name=superagent');
  if (!has('user.email')) args.push('-c', 'user.email=superagent@localhost');
  return args;
}

function init(args, ctx) {
  const title = strFlag(args, 'title');
  if (!title) throw new UsageError('init requires --title <title>');
  const wantGit = args.flags['git-init'] === true;

  let root;
  try {
    root = mainRoot(ctx.cwd);
  } catch {
    if (!wantGit) throw new UsageError('not inside a git repository; pass --git-init to create one here');
    git(['init', '-q', '-b', 'main'], ctx.cwd);
    root = mainRoot(ctx.cwd);
  }
  if (!hasHead(root)) {
    if (!wantGit) throw new UsageError('the repository has no commits; pass --git-init to create an initial empty commit');
    git([...gitUserArgs(root), 'commit', '-q', '--allow-empty', '-m', 'chore: initial commit'], root);
  }

  const existing = activeRunId(root);
  if (existing) {
    let live = true;
    try { live = !TERMINAL.includes(loadRun(root, existing).phase); } catch { live = true; }
    if (live) throw new RefusalError(`run ${existing} is still active; finish it or run \`superagent abort\` first`);
  }
  const run = createRun(root, { title });
  console.log(`run: ${run.id}`);
  console.log(`state: ${stateDir(root)}`);
}

init.booleans = ['git-init'];

function approve(args, ctx) {
  const { root, run } = ctx.resolveRun(args);
  if (run.phase !== 'awaiting_approval') {
    throw new UsageError(`cannot approve: phase is ${run.phase}, expected awaiting_approval`);
  }
  const dirty = dirtyFiles(root);
  if (dirty.length) {
    console.log('Working tree has uncommitted changes:');
    for (const f of dirty) console.log(`  ${f}`);
    throw new RefusalError('refusing to approve with a dirty working tree; commit or stash these files first');
  }
  const charter = readCharter(root, run);
  const sha = createHash('sha256').update(charter).digest('hex');
  if (run.integration_branch) return reapprove(root, run, sha);
  const baseBranch = git(['branch', '--show-current'], root);
  if (!baseBranch) throw new RefusalError('HEAD is detached; check out a branch before approving');
  const baseSha = git(['rev-parse', 'HEAD'], root);
  const integration = `superagent/${run.id}`;
  git(['checkout', '-q', '-b', integration], root);

  const tickets = loadTickets(root, run.id);
  run.charter_sha256 = sha;
  run.base_branch = baseBranch;
  run.base_sha = baseSha;
  run.integration_branch = integration;
  run.current_wave = tickets.length ? Math.min(...tickets.map((t) => t.wave)) : null;
  run.phase = 'running';
  saveRun(root, run);
  appendEvent(root, run.id, 'approved', {
    charter_sha256: run.charter_sha256, base_branch: baseBranch, base_sha: baseSha, integration_branch: integration,
  });
  console.log(`approved ${run.id}; charter frozen (${run.charter_sha256.slice(0, 12)}); on branch ${integration}`);
}

/** Approval of a revised charter: the run already has its integration branch, base and wave. */
function reapprove(root, run, sha) {
  const current = git(['branch', '--show-current'], root);
  if (current !== run.integration_branch) {
    throw new RefusalError(`refusing to approve: integration branch ${run.integration_branch} is not checked out (on ${current || 'a detached HEAD'})`);
  }
  let from = 'running';
  try {
    const lines = readFileSync(join(stateDir(root), 'runs', run.id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let ev;
      try { ev = JSON.parse(lines[i]); } catch { continue; }
      if (ev.type === 'charter_revised') {
        if (PHASES.includes(ev.from) && !['proposing', 'awaiting_approval', 'done', 'aborted'].includes(ev.from)) from = ev.from;
        break;
      }
    }
  } catch { /* no event log: fall back to running */ }
  run.charter_sha256 = sha;
  run.phase = from;
  saveRun(root, run);
  appendEvent(root, run.id, 'approved', { rev: run.charter_rev, charter_sha256: sha });
  console.log(`approved charter r${run.charter_rev} of ${run.id} (${sha.slice(0, 12)}); phase back to ${from}`);
}

function abort(args, ctx) {
  const root = ctx.root();
  const activeId = activeRunId(root);
  const id = strFlag(args, 'run') ?? activeId;
  let run;
  try {
    ({ run } = ctx.resolveRun(args));
  } catch (e) {
    // An active run whose state cannot be loaded would block `init` forever: drop the pointer only.
    if (!(e instanceof StateError) || !id || id !== activeId) throw e;
    rmSync(join(stateDir(root), 'active'), { force: true });
    process.stderr.write(`superagent: warning: ${e.message}; cleared the active pointer (the run folder was left untouched)\n`);
    return;
  }
  if (run.phase === 'aborted') { console.log(`run ${run.id} is already aborted`); return; }
  if (run.phase === 'done') throw new UsageError(`run ${run.id} is already done`);
  const from = run.phase;
  run.phase = 'aborted';
  saveRun(root, run);
  appendEvent(root, run.id, 'aborted', { from });
  if (activeRunId(root) === run.id) rmSync(join(stateDir(root), 'active'), { force: true });
  console.log(`aborted ${run.id}; branches and worktrees left untouched`);
}

function show(args, ctx) {
  const { root, run } = ctx.resolveRun(args);
  const json = args.flags.json === true;
  const charter = args.flags.charter === true;
  if (json && charter) throw new UsageError('show: use only one of --json and --charter');
  if (charter) { process.stdout.write(readCharter(root, run)); return; }
  const tickets = loadTickets(root, run.id);
  if (json) {
    const lastReports = {};
    for (const t of tickets) {
      const report = loadLastReport(root, run.id, t.id);
      if (report) lastReports[t.id] = report;
    }
    console.log(JSON.stringify({ run, tickets, lastReports }, null, 2));
    return;
  }
  const counts = {};
  for (const t of tickets) counts[t.status] = (counts[t.status] ?? 0) + 1;
  const summary = Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ') || 'none';
  console.log(`run:         ${run.id}`);
  console.log(`title:       ${run.title}`);
  console.log(`phase:       ${run.phase}`);
  console.log(`wave:        ${run.current_wave ?? '-'}`);
  console.log(`charter:     r${run.charter_rev} (${run.charter_sha256 ? 'frozen' : 'not frozen'})`);
  console.log(`branch:      ${run.integration_branch ?? '-'} (base ${run.base_branch ?? '-'})`);
  console.log(`tickets:     ${tickets.length} (${summary})`);
}
show.booleans = ['json', 'charter'];

function phase(args, ctx) {
  const [next] = args.positional;
  if (!next || !PHASES.includes(next)) throw new UsageError(`usage: superagent phase <${PHASES.join('|')}>`);
  const { root, run } = ctx.resolveRun(args);
  const from = run.phase;
  run.phase = next;
  saveRun(root, run);
  appendEvent(root, run.id, 'phase', { from, to: next });
  console.log(`${run.id}: ${from} -> ${next}`);
}

export default { init, approve, abort, show, phase };
