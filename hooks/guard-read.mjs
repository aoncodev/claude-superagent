#!/usr/bin/env node
// PreToolUse guard for Read, Grep and Glob: the fidelity reviewer may read only its review worktree.
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { resolveReal } from '../lib/guard.mjs';
import { activeRunId, loadRun } from '../lib/state.mjs';
import { runGuard } from './guard-common.mjs';

const REVIEWER = 'superagent:fidelity-reviewer';
const REASON = 'Blocked: the fidelity reviewer may read only its review worktree.';

/** Is `p` equal to directory `dir` or strictly inside it? Both must already be real paths. */
function inside(dir, p) {
  if (p === dir) return true;
  const rel = relative(dir, p);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

await runGuard(({ payload, root }) => {
  // Every caller but the fidelity reviewer keeps its ordinary Read/Grep/Glob access.
  if (payload.agent_type !== REVIEWER) return { allow: true };
  const input = payload.tool_input ?? {};
  // Grep and Glob may omit the path: they search the caller's cwd, so judge that instead.
  const given = payload.tool_name === 'Read' ? input.file_path : input.path;
  const requested = typeof given === 'string' && given !== '' ? given : payload.cwd;
  // Not normalised on purpose: "link/.." must be judged by where the symlink leads.
  const absPath = isAbsolute(requested) ? requested : `${payload.cwd}/${requested}`;

  let run;
  try {
    const id = activeRunId(root);
    // Missing state: fail open with a warning, like the other guards, instead of locking the reviewer out.
    if (!id) return { allow: true, warning: 'no active run; the fidelity reviewer read guard cannot check its review worktree' };
    run = loadRun(root, id);
  } catch (e) {
    // Unreadable state: fail open with a warning, like the other guards.
    return { allow: true, warning: e?.message ?? String(e) };
  }

  const worktree = run.review_worktree;
  // No recorded review worktree: nothing is readable for the reviewer.
  if (typeof worktree !== 'string' || worktree === '') return { allow: false, reason: REASON };
  const realWorktree = resolveReal(isAbsolute(worktree) ? worktree : resolve(root, worktree));
  // A recorded worktree that is, or contains, the main checkout is not an isolation boundary.
  if (inside(realWorktree, resolveReal(root))) return { allow: false, reason: REASON };
  return inside(realWorktree, resolveReal(absPath)) ? { allow: true } : { allow: false, reason: REASON };
});
