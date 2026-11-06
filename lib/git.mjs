import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { GitError } from './errors.mjs';

/** Paths under these prefixes are superagent's own and never count as dirty. */
export const IGNORED_PREFIXES = ['.superagent/', '.claude/worktrees/'];

function run(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const stderr = (e.stderr ?? '').toString().trim();
    throw new GitError(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : `: ${e.message}`}`);
  }
}

/** Run git (never through a shell). Returns trimmed stdout; throws GitError including stderr. */
export function git(args, cwd) {
  return run(args, cwd).trim();
}

/** Absolute path of the main checkout, correct from inside any linked worktree. */
export function mainRoot(cwd) {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return dirname(common);
}

function realOrResolved(p) {
  const abs = resolve(p);
  try { return realpathSync(abs); } catch { /* path may not exist yet */ }
  // Resolve the nearest existing ancestor so symlinked temp dirs still match.
  const parent = dirname(abs);
  return parent === abs ? abs : join(realOrResolved(parent), basename(abs));
}

/** Every worktree from `git worktree list --porcelain`; the first entry is the main checkout. */
export function listWorktrees(root) {
  const out = run(['worktree', 'list', '--porcelain'], root);
  const trees = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), branch: null, isMain: trees.length === 0 };
      trees.push(cur);
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  return trees;
}

/** The worktree whose path is the longest prefix of absPath, or null. */
export function worktreeContaining(absPath, root) {
  const trees = listWorktrees(root);
  const target = realOrResolved(absPath);
  let best = null;
  for (const t of trees) {
    const p = realOrResolved(t.path);
    if (target === p || target.startsWith(p.endsWith(sep) ? p : p + sep)) {
      if (!best || p.length > best.len) best = { len: p.length, t: { ...t, path: p } };
    }
  }
  return best ? best.t : null;
}

/** Porcelain paths with changes (including untracked files), excluding superagent's own paths. */
export function dirtyFiles(cwd) {
  const out = run(['status', '--porcelain', '-z', '--untracked-files=all'], cwd);
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    files.push(entry.slice(3));
    if (status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') i++; // skip the origin path
  }
  return files.filter((f) => !IGNORED_PREFIXES.some((p) => f.startsWith(p)));
}

/** Files changed on `to` since it diverged from `from` (git diff --name-only from...to). */
export function diffNames(cwd, from, to) {
  // -z: NUL-separated and unquoted, so non-ASCII paths are returned verbatim.
  const out = run(['diff', '--name-only', '-z', `${from}...${to}`], cwd);
  return out.split('\0').filter(Boolean);
}

/** Is `cwd` inside a linked worktree (not the main checkout)? False outside a git work tree. */
export function inLinkedWorktree(cwd) {
  let top;
  let main;
  try {
    top = git(['rev-parse', '--show-toplevel'], cwd);
    main = mainRoot(cwd);
  } catch {
    return false;
  }
  return realOrResolved(top) !== realOrResolved(main);
}

export function hasHead(cwd) {
  try {
    run(['rev-parse', '--verify', '-q', 'HEAD'], cwd);
    return true;
  } catch {
    return false;
  }
}

/** Is commit `a` an ancestor of (or equal to) `b`? False when either does not resolve. */
export function isAncestor(cwd, a, b) {
  try {
    run(['merge-base', '--is-ancestor', a, b], cwd);
    return true;
  } catch {
    return false;
  }
}

/** Number of commits on `to` that are not on `from` (git rev-list --count from..to). */
export function commitsAhead(cwd, from, to) {
  return Number(git(['rev-list', '--count', `${from}..${to}`], cwd));
}

const MARKER_LINE = /^(<{7}|\|{7}|>{7})(\s|$)/;

/**
 * Files that still hold leftover conflict markers. `diffArgs` picks the diff: ['--cached'] for a merge being
 * resolved in the index, ['HEAD^1', 'HEAD'] for a merge already committed. `rev` says where to read that
 * diff's new side ('' for the index, 'HEAD' for the commit). `paths`, when given, limits the check to them.
 * git's --check also flags a bare "=======" line, which is an ordinary Markdown heading underline, so a file
 * counts only when a flagged line is a "<<<<<<<", "|||||||" or ">>>>>>>" marker. A real leftover conflict
 * always has those. A file whose content cannot be read back is counted, to be safe.
 */
export function conflictMarkerFiles(cwd, diffArgs, { rev = '', paths = null } = {}) {
  if (paths && paths.length === 0) return [];
  const opts = { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  const r = spawnSync('git', ['-c', 'core.quotePath=false', '--literal-pathspecs', 'diff', '--check', ...diffArgs, ...(paths ? ['--', ...paths] : [])], opts);
  const flagged = new Map();
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = /^(.+):(\d+): leftover conflict marker$/.exec(line);
    if (m) flagged.set(m[1], [...(flagged.get(m[1]) ?? []), Number(m[2])]);
  }
  const files = [];
  for (const [file, lineNos] of flagged) {
    const shown = spawnSync('git', ['show', `${rev}:${file}`], opts);
    if (shown.status !== 0) { files.push(file); continue; }
    const lines = shown.stdout.split('\n');
    if (lineNos.some((n) => MARKER_LINE.test(lines[n - 1] ?? ''))) files.push(file);
  }
  return files;
}
