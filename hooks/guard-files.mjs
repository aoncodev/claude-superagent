#!/usr/bin/env node
// PreToolUse guard for Write, Edit, MultiEdit and NotebookEdit. See lib/guard.mjs for the rules.
import { isAbsolute, resolve } from 'node:path';
import { listWorktrees } from '../lib/git.mjs';
import { decideFileWrite, guarded, pickWorktree, resolveReal } from '../lib/guard.mjs';
import { activeRunId, loadRun, loadTickets } from '../lib/state.mjs';
import { runGuard } from './guard-common.mjs';

await runGuard(({ payload, root }) => {
  const input = payload.tool_input ?? {};
  const given = input.file_path ?? input.notebook_path;
  if (typeof given !== 'string' || given === '') return { allow: true };
  // Not normalised on purpose: "link/.." must be judged by where the symlink leads.
  const absPath = isAbsolute(given) ? given : `${payload.cwd}/${given}`;

  let run = null;
  let tickets = [];
  let worktree = null;
  let lexicalWorktree = null;
  let cwdWorktree = null;
  let warning = null;
  try {
    const id = activeRunId(root);
    if (id) {
      run = loadRun(root, id);
      if (guarded(run)) {
        tickets = loadTickets(root, id);
        const trees = listWorktrees(root);
        const realTrees = trees.map((t) => ({ ...t, path: resolveReal(t.path) }));
        worktree = pickWorktree(resolveReal(absPath), realTrees);
        lexicalWorktree = pickWorktree(resolve(absPath), [...trees, ...realTrees]);
        cwdWorktree = pickWorktree(resolveReal(payload.cwd), realTrees);
      }
    }
  } catch (e) {
    // Unreadable state: only the path-only rule 1 can still be enforced.
    run = null; tickets = []; worktree = null; lexicalWorktree = null; cwdWorktree = null;
    warning = e?.message ?? String(e);
  }
  const d = decideFileWrite({ absPath, root, run, tickets, worktree, lexicalWorktree, cwdWorktree, agentType: payload.agent_type });
  return !d.allow || !warning ? d : { allow: true, warning };
});
