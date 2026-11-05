// Pure decision functions for the PreToolUse guard hooks. The only I/O here is symlink resolution
// (resolveReal), which callers may replace through the `realpath` field for testing.
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { normalizeRel, ownsPath } from './plan.mjs';

export const ACTIVE_PHASES = ['running', 'merging', 'verifying', 'reviewing'];

const ALLOW = { allow: true };
const deny = (reason) => ({ allow: false, reason });
const RUNS_REASON = 'Run state is changed only through the superagent CLI.';

// ---------------------------------------------------------------- paths

/**
 * Resolve symlinks the way the OS would, for a path that may not exist yet: realpath of the nearest
 * existing ancestor (raw string, so "link/.." is judged by where link leads), then the remaining
 * components appended. A dangling symlink is followed to where a write would create the file.
 */
export function resolveReal(p, depth = 0) {
  if (depth > 16) return resolve(p);
  const rest = [];
  let cur = isAbsolute(p) ? p : resolve(p);
  for (;;) {
    try {
      return resolve(realpathSync.native(cur), ...rest);
    } catch { /* not resolvable as is */ }
    try {
      if (lstatSync(cur).isSymbolicLink()) {
        return resolveReal(resolve(dirname(cur), readlinkSync(cur), ...rest), depth + 1);
      }
    } catch { /* does not exist */ }
    const parent = dirname(cur);
    if (parent === cur) return resolve(cur, ...rest);
    rest.unshift(basename(cur));
    cur = parent;
  }
}

const lower = (s) => s.toLowerCase();
/** Is `p` strictly inside directory `dir`? Segment-aware. */
function under(dir, p, { ci = false } = {}) {
  const d = ci ? lower(dir) : dir;
  const q = ci ? lower(p) : p;
  return q.startsWith(d.endsWith(sep) ? d : d + sep);
}

/** Longest-prefix worktree for a path, compared lexically (no symlink following) against each tree path. */
export function pickWorktree(absPath, trees) {
  const target = resolve(absPath);
  let best = null;
  for (const t of trees) {
    if (target === t.path || under(t.path, target)) {
      if (!best || t.path.length > best.path.length) best = t;
    }
  }
  return best;
}

// ---------------------------------------------------------------- file writes

function sameTree(a, b) {
  return a && b && a.path === b.path;
}

/**
 * ctx: { absPath, root, run, tickets, worktree, lexicalWorktree?, agentType?, realpath? }
 *   worktree         worktree containing the symlink-resolved path (or null)
 *   lexicalWorktree  worktree containing the path as written, before symlinks (or null)
 */
export function decideFileWrite(ctx) {
  const real = ctx.realpath ?? resolveReal;
  const { root, run } = ctx;
  const tickets = ctx.tickets ?? [];
  const lexAbs = resolve(ctx.absPath);
  const realAbs = real(ctx.absPath);
  const realRoot = real(root);

  // Rule 1: run state is the CLI's alone (every phase, with or without a run).
  const stateRoots = [root, realRoot, ...[ctx.worktree, ctx.lexicalWorktree].filter(Boolean).map((t) => t.path)];
  for (const r of stateRoots) {
    const runsDir = resolve(r, '.superagent', 'runs');
    if (under(runsDir, lexAbs, { ci: true }) || under(runsDir, realAbs, { ci: true })) return deny(RUNS_REASON);
  }

  // Drafts (worker reports, orchestrator plans) are writable in every phase.
  if (under(resolve(realRoot, '.superagent', 'drafts'), realAbs)) return ALLOW;

  // Rule 2
  if (!run || !ACTIVE_PHASES.includes(run.phase)) return ALLOW;

  // Rules 3-5, for every worktree the path touches (as written and as resolved).
  const candidates = [ctx.worktree, ctx.lexicalWorktree].filter(Boolean);
  if (candidates.length === 2 && sameTree(candidates[0], candidates[1])) candidates.pop();
  for (const wt of candidates) {
    const d = decideInWorktree({ ...ctx, tickets, real, realAbs }, wt);
    if (!d.allow) return d;
  }
  return ALLOW;
}

function decideInWorktree(ctx, wt) {
  const { run, tickets, real, realAbs } = ctx;
  if (wt.isMain) {
    // Rule 5
    if (run.phase === 'running') {
      return deny('The main checkout is read-only while a wave runs; workers edit only in their worktrees.');
    }
    return ALLOW;
  }
  const realWt = real(wt.path);
  const ticket = tickets.find((t) => typeof t.worktree === 'string' && t.worktree && real(t.worktree) === realWt);
  // Rule 4
  if (!ticket) return deny('Run `superagent claim <ticket>` from your worktree first.');
  // Rule 3
  const owns = Array.isArray(ticket.owns) ? ticket.owns : [];
  const who = ctx.agentType ? ` (${ctx.agentType})` : '';
  const scope = `${ticket.id} owns ${owns.length ? owns.join(', ') : '(nothing)'}`;
  const rel = relative(realWt, realAbs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return deny(`Blocked${who}: this path resolves outside your worktree or to its root. ${scope}. Out-of-scope needs go in your report's handbacks.`);
  }
  const norm = normalizeRel(rel);
  if (norm === null || !ownsPath(owns, norm)) {
    return deny(`Blocked${who}: ${norm ?? rel} is outside the paths ${scope}. Out-of-scope needs go in your report's handbacks.`);
  }
  return ALLOW;
}

// ---------------------------------------------------------------- bash

const FLAGS = String.raw`(?:-\S+(?:\s+[^-\s]\S*)?\s+)*`;
/** `cmd [global flags] (subs)` anywhere in a command part, not preceded by a word character. */
const sub = (cmd, subs) => new RegExp(String.raw`(?<![\w.-])${cmd}\s+${FLAGS}(?:${subs})(?![\w-])`);

const SUBCOMMAND_RULES = [
  ['push', sub('git', 'push')],
  ['push', sub('gh', String.raw`pr\s+merge`)],
  ['deploy', sub('fly', 'deploy')],
  ['deploy', sub('flyctl', 'deploy')],
  ['deploy', sub('railway', 'up')],
  ['deploy', sub('kubectl', 'apply|delete|rollout')],
  ['deploy', sub('helm', 'install|upgrade')],
  ['deploy', sub('terraform', 'apply|destroy')],
  ['deploy', sub('pulumi', 'up')],
  ['deploy', sub('serverless', 'deploy')],
  ['deploy', sub('sls', 'deploy')],
  ['deploy', sub('firebase', 'deploy')],
  ['deploy', sub('docker', String.raw`(?:image\s+)?push`)],
  ['publish', sub('npm', 'publish')],
  ['publish', sub('pnpm', 'publish')],
  ['publish', sub('yarn', String.raw`(?:npm\s+)?publish`)],
  ['publish', sub('cargo', 'publish')],
  ['publish', sub('twine', 'upload')],
  ['publish', sub('gh', String.raw`release\s+create`)],
  ['publish', sub('eas', 'submit')],
];

// Commands recognised only in command position (after prefixes are stripped), so mentions in
// arguments such as `cat heroku.md` or a commit message do not trip them.
const COMMAND_RULES = [
  ['deploy', (n) => /^heroku(\s|$)/.test(n)],
  ['deploy', (n) => /^vercel(\s|$)/.test(n) && /\s--prod\b/.test(n)],
  ['deploy', (n) => /^netlify\s/.test(n) && /\sdeploy\b/.test(n) && /\s(--prod\b|-p\b)/.test(n)],
  ['publish', (n) => /^fastlane(\s|$)/.test(n)],
];

const WRAPPERS = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U'],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '-S'],
  xargs: ['-I', '-n', '-P', '-L', '-d', '-s', '-E'],
  command: [], builtin: [], time: [], nohup: [], exec: [], npx: [], bunx: [], nice: ['-n'], stdbuf: [], caffeinate: [],
};
const RUNNERS = new Set(['pnpm', 'yarn', 'npm', 'bun']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

const unquote = (t) => t.replace(/^["'`]+|["'`]+$/g, '');

/** Tokens of a command part with VAR=value assignments and sudo/env/command/npx-style prefixes removed. */
function commandTokens(part) {
  const toks = part.trim().split(/\s+/).filter(Boolean).map(unquote).filter(Boolean);
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
    if (t === '{' || t === '!' || t === 'then' || t === 'do' || t === 'else') { i++; continue; }
    const b = basename(t);
    if (Object.hasOwn(WRAPPERS, b)) {
      i++;
      while (i < toks.length && toks[i].startsWith('-')) {
        const takesValue = WRAPPERS[b].includes(toks[i]);
        i += takesValue ? 2 : 1;
      }
      continue;
    }
    if (RUNNERS.has(b) && ['exec', 'dlx', 'x'].includes(toks[i + 1])) {
      i += 2;
      while (i < toks.length && toks[i].startsWith('-')) i++;
      continue;
    }
    break;
  }
  const rest = toks.slice(i);
  if (rest.length) rest[0] = basename(rest[0]);
  return rest;
}

/** Split a shell line into command parts on && || ; | & newlines, subshell parentheses, backticks, braces. */
function splitParts(command) {
  return command.split(/&&|\|\||\$\(|[;|&\n()`{}]/).map((s) => s.trim()).filter(Boolean);
}

function outwardActions(part, found, depth = 0) {
  for (const [action, re] of SUBCOMMAND_RULES) if (re.test(part)) found.add(action);
  const toks = commandTokens(part);
  const norm = toks.join(' ');
  for (const [action, test] of COMMAND_RULES) if (test(norm)) found.add(action);
  // bash -c "..." / eval "...": look inside the string.
  if (depth < 3 && toks.length > 1 && (SHELLS.has(toks[0]) || toks[0] === 'eval')) {
    const inner = toks.slice(1).filter((t) => t !== '-c' && t !== '-lc' && t !== '-ic').join(' ');
    for (const p of splitParts(inner)) outwardActions(p, found, depth + 1);
  }
}

const touchesRuns = (tok) => {
  const n = posix.normalize(unquote(tok).replaceAll('\\', '/'));
  return /(^|\/)\.superagent\/runs(\/|$)/i.test(n);
};

const NAMING_COMMANDS = new Set(['rm', 'mv', 'rmdir', 'unlink', 'truncate', 'touch', 'ln', 'shred', 'tee']);

/** Does this command part write to, or remove, something under .superagent/runs/ (ignoring redirections)? */
function partWritesRuns(toks, inRuns) {
  if (!toks.length) return false;
  const [cmd, ...args] = toks;
  const operands = args.filter((a) => !a.startsWith('-'));
  const hit = (list) => (inRuns ? list.length > 0 || cmd === 'tee' : list.some(touchesRuns));
  if (NAMING_COMMANDS.has(cmd)) return hit(operands);
  if (cmd === 'cp' || cmd === 'install') return hit(operands.slice(-1));
  if (cmd === 'sed' && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place='))) return hit(operands);
  if (cmd === 'dd') return hit(args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)));
  return false;
}

function bashWritesRuns(command, parts) {
  // Redirections: >, >>, >|, &>, 2>
  for (const m of command.matchAll(/&?\d*>>?\|?\s*["']?([^\s"';&|<>()]+)/g)) {
    if (touchesRuns(m[1])) return true;
  }
  let inRuns = false;
  for (const part of parts) {
    const toks = commandTokens(part);
    if (partWritesRuns(toks, inRuns)) return true;
    if ((toks[0] === 'cd' || toks[0] === 'pushd') && toks[1] && touchesRuns(`${toks[1]}/`)) inRuns = true;
    if (inRuns && /(^|[^<>\d&])\d*>>?\s*[^\s&]/.test(part)) return true; // redirect while cd'd into runs/
  }
  return false;
}

/** ctx: { command, run, config }. Outward actions are checked only while a run is active. */
export function decideBash(ctx) {
  const { command, run } = ctx;
  if (typeof command !== 'string' || command === '') return ALLOW;
  const parts = splitParts(command);

  if (bashWritesRuns(command, parts)) return deny(RUNS_REASON);
  if (!run || !ACTIVE_PHASES.includes(run.phase)) return ALLOW;

  const allowedActions = new Set(run.allowed_actions ?? []);
  const found = new Set();
  for (const p of parts) outwardActions(p, found);
  const markers = (ctx.config?.production_markers ?? []).filter((m) => typeof m === 'string' && m !== '');
  const lowered = lower(command);
  if (markers.some((m) => lowered.includes(lower(m)))) found.add('production');

  for (const action of ['push', 'deploy', 'publish', 'production']) {
    if (found.has(action) && !allowedActions.has(action)) {
      return deny(`Blocked: \`${action}\` is not in this run's approved Charter. Ask the user; a Charter revision can allow it.`);
    }
  }
  return ALLOW;
}
