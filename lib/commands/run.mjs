import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { strFlag } from '../cli.mjs';
import { RefusalError, UsageError } from '../errors.mjs';
import { dirtyFiles, git, hasHead, mainRoot } from '../git.mjs';
import {
  PHASES, activeRunId, appendEvent, createRun, loadRun, loadTickets, readCharter, saveRun, stateDir,
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
  const baseBranch = git(['branch', '--show-current'], root);
  if (!baseBranch) throw new RefusalError('HEAD is detached; check out a branch before approving');
  const baseSha = git(['rev-parse', 'HEAD'], root);
  const integration = `superagent/${run.id}`;
  git(['checkout', '-q', '-b', integration], root);

  const tickets = loadTickets(root, run.id);
  run.charter_sha256 = createHash('sha256').update(charter).digest('hex');
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

function abort(args, ctx) {
  const { root, run } = ctx.resolveRun(args);
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
    console.log(JSON.stringify({ run, tickets, lastReports: {} }, null, 2));
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
