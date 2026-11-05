import { GitError, RefusalError, UsageError } from '../errors.mjs';
import {
  commitsAhead, conflictMarkerFiles, dirtyFiles, diffNames, git, isAncestor,
} from '../git.mjs';
import { ownsPath } from '../plan.mjs';
import { appendEvent, loadTickets, saveRun, saveTicket } from '../state.mjs';

function ticketArg(args, ctx, cmd) {
  const [id] = args.positional;
  if (!id) throw new UsageError(`usage: superagent ${cmd} <ticket-id>`);
  const { root, run } = ctx.resolveRun(args);
  const ticket = loadTickets(root, run.id).find((t) => t.id === id);
  if (!ticket) throw new UsageError(`unknown ticket: ${id}`);
  return { root, run, ticket };
}

/** Paths the ticket's branch changed that its `owns` do not cover. */
function violations(root, run, ticket) {
  if (!run.integration_branch) throw new RefusalError('the run has no integration branch yet; approve it first');
  if (!ticket.branch) throw new RefusalError(`${ticket.id} has no branch; it was never claimed from a worktree`);
  return diffNames(root, run.integration_branch, ticket.branch).filter((f) => !ownsPath(ticket.owns, f));
}

function checkDiff(args, ctx) {
  const { root, run, ticket } = ticketArg(args, ctx, 'check-diff');
  const bad = violations(root, run, ticket);
  if (bad.length) {
    console.log(`${ticket.id} changed paths outside its owns (${ticket.owns.join(', ')}):`);
    for (const f of bad) console.log(`  ${f}`);
    throw new RefusalError(`${ticket.id}: ${bad.length} path${bad.length === 1 ? '' : 's'} outside owns`);
  }
  console.log(`${ticket.id}: diff is within owns`);
}

function requireIntegrationBranch(root, run) {
  const current = git(['branch', '--show-current'], root);
  if (current !== run.integration_branch) {
    throw new RefusalError(`integration branch ${run.integration_branch} is not checked out in the main checkout (on ${current || 'a detached HEAD'})`);
  }
}

// -z: NUL-separated and unquoted, so non-ASCII or oddly named paths come back verbatim.
const conflictedFiles = (root) => git(['diff', '--name-only', '--diff-filter=U', '-z'], root).split('\0').filter(Boolean);

function mergeTicket(args, ctx) {
  const { root, run, ticket } = ticketArg(args, ctx, 'merge');
  const phaseOk = run.phase === 'running' || (run.phase === 'merging' && !run.merging_ticket);
  if (!phaseOk) {
    const why = run.merging_ticket ? `${run.merging_ticket} is mid-merge; run merge-continue first` : `run phase is ${run.phase}, expected running`;
    throw new RefusalError(`cannot merge ${ticket.id}: ${why}`);
  }
  requireIntegrationBranch(root, run);
  const dirty = dirtyFiles(root);
  if (dirty.length) {
    console.log('Main checkout has uncommitted changes:');
    for (const f of dirty) console.log(`  ${f}`);
    throw new RefusalError(`cannot merge ${ticket.id}: the main checkout is not clean`);
  }
  if (ticket.status !== 'ready') throw new RefusalError(`cannot merge ${ticket.id}: status is ${ticket.status}, expected ready`);
  if (ticket.branch && commitsAhead(root, run.integration_branch, ticket.branch) === 0) {
    throw new RefusalError(`cannot merge ${ticket.id}: its branch ${ticket.branch} has no commits beyond ${run.integration_branch}; nothing would be merged`);
  }

  const bad = violations(root, run, ticket);
  if (bad.length) {
    ticket.status = 'failed';
    saveTicket(root, run.id, ticket);
    appendEvent(root, run.id, 'handback', {
      ticket: ticket.id,
      need: `changes outside ${ticket.id}'s owned paths: ${bad.join(', ')}`,
      reason: 'diff check failed before merge; the branch was not merged',
      paths: bad,
    });
    console.log(`${ticket.id} changed paths outside its owns (${ticket.owns.join(', ')}); not merged:`);
    for (const f of bad) console.log(`  ${f}`);
    throw new RefusalError(`${ticket.id} failed the diff check; the out-of-scope paths were recorded as a handback`);
  }

  const startPhase = run.phase;
  run.phase = 'merging';
  saveRun(root, run);
  try {
    git(['merge', '--no-ff', '--no-edit', ticket.branch], root);
  } catch (e) {
    const files = conflictedFiles(root);
    if (!files.length) {
      // Not a conflict: leave nothing half-done.
      try { git(['merge', '--abort'], root); } catch { /* no merge in progress */ }
      run.phase = startPhase;
      saveRun(root, run);
      throw e;
    }
    run.merging_ticket = ticket.id;
    saveRun(root, run);
    appendEvent(root, run.id, 'merge_conflict', { ticket: ticket.id, files });
    console.log(`Merge of ${ticket.id} stopped on conflicts in:`);
    for (const f of files) console.log(`  ${f}`);
    throw new RefusalError('resolve the conflicts, `git add` the files, then run `superagent merge-continue`');
  }
  finishMerge(root, run, ticket);
}

function finishMerge(root, run, ticket) {
  const sha = git(['rev-parse', 'HEAD'], root);
  ticket.status = 'merged';
  saveTicket(root, run.id, ticket);
  run.phase = 'running';
  run.merging_ticket = null;
  saveRun(root, run);
  appendEvent(root, run.id, 'merged', { ticket: ticket.id, sha });
  console.log(`${ticket.id}: merged (${sha.slice(0, 12)})`);
}

function mergeContinue(args, ctx) {
  const { root, run } = ctx.resolveRun(args);
  if (!run.merging_ticket) throw new RefusalError('no merge is in progress (merging_ticket is not set)');
  const ticket = loadTickets(root, run.id).find((t) => t.id === run.merging_ticket);
  if (!ticket) throw new RefusalError(`merging ticket ${run.merging_ticket} no longer exists`);
  requireIntegrationBranch(root, run);
  const files = conflictedFiles(root);
  if (files.length) {
    console.log('Unresolved conflicts remain in:');
    for (const f of files) console.log(`  ${f}`);
    throw new RefusalError('resolve the conflicts and `git add` the files before running merge-continue');
  }
  if (mergeInProgress(root)) {
    const marked = conflictMarkerFiles(root, ['--cached']);
    if (marked.length) {
      console.log('Staged files still hold conflict markers:');
      for (const f of marked) console.log(`  ${f}`);
      throw new RefusalError('remove the conflict markers, `git add` the files, then run merge-continue again');
    }
    try {
      git(['commit', '--no-edit'], root);
    } catch (e) {
      throw new GitError(`could not commit the merge: ${e.message}`);
    }
  } else {
    // No merge in progress: only a merge the user already committed counts. An aborted merge does not.
    if (!ticket.branch || !isAncestor(root, ticket.branch, 'HEAD')) {
      throw new RefusalError(`${ticket.id} is not merged: no merge is in progress and ${ticket.branch ?? 'its branch'} is not in ${run.integration_branch}. Run \`superagent merge-abort ${ticket.id}\` to give up on this merge`);
    }
    const marked = git(['rev-list', '--parents', '-n', '1', 'HEAD'], root).split(' ').length > 2
      ? conflictMarkerFiles(root, ['HEAD^1', 'HEAD']) : [];
    if (marked.length) {
      console.log('The merge commit still holds conflict markers in:');
      for (const f of marked) console.log(`  ${f}`);
      throw new RefusalError('remove the conflict markers and commit the fix, then run merge-continue again');
    }
  }
  finishMerge(root, run, ticket);
}

function mergeInProgress(root) {
  try {
    git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], root);
    return true;
  } catch {
    return false;
  }
}

/** Give up on the ticket being merged: abort any merge in progress, fail the ticket, hand it back. */
function mergeAbort(args, ctx) {
  const { root, run, ticket } = ticketArg(args, ctx, 'merge-abort');
  if (run.phase !== 'merging' || !run.merging_ticket) throw new RefusalError(`no merge to abort: run phase is ${run.phase}, expected merging`);
  if (run.merging_ticket !== ticket.id) throw new RefusalError(`cannot abort ${ticket.id}: the ticket being merged is ${run.merging_ticket}`);
  requireIntegrationBranch(root, run);
  if (mergeInProgress(root)) git(['merge', '--abort'], root);
  ticket.status = 'failed';
  saveTicket(root, run.id, ticket);
  run.phase = 'running';
  run.merging_ticket = null;
  saveRun(root, run);
  appendEvent(root, run.id, 'merge_aborted', { ticket: ticket.id });
  appendEvent(root, run.id, 'handback', {
    ticket: ticket.id,
    need: `${ticket.id}'s branch ${ticket.branch ?? '(none)'} could not be merged; its work is not in ${run.integration_branch}`,
    reason: 'merge aborted',
  });
  console.log(`${ticket.id}: merge aborted; ticket failed and recorded as a handback`);
}

function nextWave(args, ctx) {
  const { root, run } = ctx.resolveRun(args);
  const tickets = loadTickets(root, run.id);
  // Fix and fidelity waves: tickets added after the last wave re-enter the wave loop from verifying/reviewing.
  if (run.phase === 'verifying' || run.phase === 'reviewing') {
    const planned = tickets.filter((t) => t.status === 'planned').map((t) => t.wave);
    if (!planned.length) throw new RefusalError(`cannot advance the wave: run phase is ${run.phase} and no ticket is planned`);
    const from = run.phase;
    const fromWave = run.current_wave;
    run.phase = 'running';
    run.current_wave = Math.min(...planned);
    saveRun(root, run);
    appendEvent(root, run.id, 'phase', { from, to: 'running' });
    appendEvent(root, run.id, 'wave_advanced', { from: fromWave, to: run.current_wave });
    console.log(`wave ${run.current_wave}`);
    return;
  }
  if (run.phase !== 'running') throw new RefusalError(`cannot advance the wave: run phase is ${run.phase}, expected running (or verifying/reviewing with planned tickets)`);
  const inWave = tickets.filter((t) => t.wave === run.current_wave);
  const unmerged = inWave.filter((t) => t.status === 'ready');
  if (unmerged.length) {
    throw new RefusalError(`cannot advance: ${unmerged.map((t) => t.id).join(', ')} finished but not merged; merge ${unmerged.length === 1 ? 'it' : 'them'} first with \`superagent merge <ticket>\``);
  }
  const open = inWave.filter((t) => ['planned', 'running', 'blocked'].includes(t.status));
  if (open.length) {
    throw new RefusalError(`cannot advance: wave ${run.current_wave} still has ${open.map((t) => `${t.id} (${t.status})`).join(', ')}`);
  }
  const from = run.current_wave;
  const later = tickets.filter((t) => t.status === 'planned' && t.wave > (from ?? -Infinity)).map((t) => t.wave);
  if (later.length) {
    run.current_wave = Math.min(...later);
    saveRun(root, run);
    appendEvent(root, run.id, 'wave_advanced', { from, to: run.current_wave });
    console.log(`wave ${run.current_wave}`);
    return;
  }
  run.phase = 'verifying';
  saveRun(root, run);
  appendEvent(root, run.id, 'phase', { from: 'running', to: 'verifying' });
  console.log('none');
}

export default {
  'check-diff': checkDiff,
  merge: mergeTicket,
  'merge-continue': mergeContinue,
  'merge-abort': mergeAbort,
  'next-wave': nextWave,
};
