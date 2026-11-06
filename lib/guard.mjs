// Pure decision functions for the PreToolUse guard hooks. The only I/O here is symlink resolution
// (resolveReal), which callers may replace through the `realpath` field for testing.
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { normalizeRel, ownsPath } from './plan.mjs';

/**
 * Is the run guarded? From the first approval (which creates the integration branch) until the run is
 * done or aborted. This includes `awaiting_approval` after a Charter revision: workers may still be live.
 */
export function guarded(run) {
  return Boolean(run && run.integration_branch && !['done', 'aborted'].includes(run.phase));
}

/** Phases in which workers may be live, so the main checkout is read-only (rule 5). */
const WORKER_PHASES = ['running', 'awaiting_approval'];

/** Files directly under .superagent/ that are run state (besides runs/): the CLI alone writes them. */
const STATE_FILES = ['active', 'config.json'];

/**
 * superagent subcommands a worker (or the fidelity reviewer) may run. Every other subcommand is the
 * orchestrator's: the CLI refuses it from a linked worktree, and guard-bash refuses it from a worker.
 */
export const WORKER_COMMANDS = new Set(['claim', 'brief', 'report', 'show', 'status', 'proposal', 'check-diff']);

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
 *   cwdWorktree      worktree containing the caller's cwd (or null); a worker may not edit another linked worktree
 */
export function decideFileWrite(ctx) {
  const real = ctx.realpath ?? resolveReal;
  const { root, run } = ctx;
  const tickets = ctx.tickets ?? [];
  const lexAbs = resolve(ctx.absPath);
  const realAbs = real(ctx.absPath);
  const realRoot = real(root);

  // Rule 1: run state (runs/, the active pointer, config.json) is the CLI's alone (every phase, with or without a run).
  const stateRoots = [root, realRoot, ...[ctx.worktree, ctx.lexicalWorktree].filter(Boolean).map((t) => t.path)];
  for (const r of stateRoots) {
    const runsDir = resolve(r, '.superagent', 'runs');
    if (under(runsDir, lexAbs, { ci: true }) || under(runsDir, realAbs, { ci: true })) return deny(RUNS_REASON);
    for (const name of STATE_FILES) {
      const file = lower(resolve(r, '.superagent', name));
      if (lower(lexAbs) === file || lower(realAbs) === file) return deny(RUNS_REASON);
    }
  }

  // Drafts (worker reports, orchestrator plans) are writable in every phase.
  if (under(resolve(realRoot, '.superagent', 'drafts'), realAbs)) return ALLOW;
  // A worker's report goes in its own worktree's drafts (its Write tool cannot leave the worktree).
  const wt = ctx.worktree;
  if (wt && !wt.isMain && under(resolve(real(wt.path), '.superagent', 'drafts'), realAbs)) {
    const cwdWt = ctx.cwdWorktree;
    if (cwdWt && !cwdWt.isMain && real(cwdWt.path) !== real(wt.path)) return deny('You may only edit inside your own worktree.');
    return ALLOW;
  }

  // Rule 2
  if (!guarded(run)) return ALLOW;

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
    // A worker never writes into the main checkout, in any guarded phase.
    if (ctx.cwdWorktree && !ctx.cwdWorktree.isMain) return deny('You may only edit inside your own worktree.');
    // Rule 5
    if (WORKER_PHASES.includes(run.phase)) {
      return deny('The main checkout is read-only while a wave runs; workers edit only in their worktrees.');
    }
    return ALLOW;
  }
  const realWt = real(wt.path);
  if (ctx.cwdWorktree && !ctx.cwdWorktree.isMain && real(ctx.cwdWorktree.path) !== realWt) {
    return deny('You may only edit inside your own worktree.');
  }
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

/** Shell-like word splitting that removes quotes and backslash escapes (no expansion). */
function tokenize(s) {
  const out = [];
  let cur = '';
  let has = false;
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === '$' && (s[i + 1] === "'" || s[i + 1] === '"')) continue; // $'..' and $".."
    if (c === '\\') { if (i + 1 < s.length) { cur += s[++i]; has = true; } continue; }
    if (/\s/.test(c)) { if (cur !== '' || has) { out.push(cur); cur = ''; has = false; } continue; }
    cur += c;
    has = true;
  }
  if (cur !== '' || has) out.push(cur);
  return out.filter((t) => t !== '');
}

/** The de-quoted form of a part as one string; whitespace inside a token is masked so it stays one word. */
const dequoted = (toks) => toks.map((t) => t.replace(/\s/g, '\u0001')).join(' ');

/** Tokens of a command part with VAR=value assignments and sudo/env/command/npx-style prefixes removed. */
function commandTokens(part) {
  const toks = tokenize(part);
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

const GIT_CLEAN_X = new RegExp(String.raw`(?<![\w.-])git\s+${FLAGS}clean(?![\w-])(?:\s+\S+)*?\s+-[A-Za-z]*[xX][A-Za-z]*(?=\s|$)`);
const GIT_STASH_ALL = new RegExp(String.raw`(?<![\w.-])git\s+${FLAGS}stash(?![\w-])(?:\s+\S+)*?\s+(?:--all|-[A-Za-z]*a[A-Za-z]*)(?=\s|$)`);

function outwardActions(part, found, depth = 0) {
  const toks = tokenize(part);
  for (const text of [part, dequoted(toks)]) {
    for (const [action, re] of SUBCOMMAND_RULES) if (re.test(text)) found.add(action);
    if (GIT_CLEAN_X.test(text)) found.add('clean-x');
    if (GIT_STASH_ALL.test(text)) found.add('stash-all');
  }
  const cmd = commandTokens(part);
  const norm = cmd.join(' ');
  for (const [action, test] of COMMAND_RULES) if (test(norm)) found.add(action);
  // bash -c "..." / eval "...": look inside the string.
  if (depth < 3 && cmd.length > 1 && (SHELLS.has(cmd[0]) || cmd[0] === 'eval')) {
    const inner = cmd.slice(1).filter((t) => t !== '-c' && t !== '-lc' && t !== '-ic').join(' ');
    for (const p of splitParts(inner)) outwardActions(p, found, depth + 1);
  }
}

const SUPERAGENT_BINS = new Set(['superagent', 'superagent.mjs']);

/** Orchestrator-only superagent subcommands invoked by a command part (looking inside bash -c / eval). */
function orchestratorCommands(part, found, depth = 0) {
  const cmd = commandTokens(part);
  let sub = null;
  if (SUPERAGENT_BINS.has(cmd[0])) sub = cmd[1];
  else if (cmd[0] === 'node' && cmd[1] && SUPERAGENT_BINS.has(basename(cmd[1]))) sub = cmd[2];
  if (sub !== undefined && sub !== null && !WORKER_COMMANDS.has(sub)) found.add(sub);
  if (depth < 3 && cmd.length > 1 && (SHELLS.has(cmd[0]) || cmd[0] === 'eval')) {
    const inner = cmd.slice(1).filter((t) => t !== '-c' && t !== '-lc' && t !== '-ic').join(' ');
    for (const p of splitParts(inner)) orchestratorCommands(p, found, depth + 1);
  }
}

/** Can the glob segment match "runs", "active" or "config.json"? */
function globMatchesState(seg) {
  try {
    const re = seg.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return ['runs', ...STATE_FILES].some((name) => new RegExp(`^${re}$`, 'i').test(name));
  } catch {
    return true;
  }
}

/** Is this path run state: runs/ or anything under it, .superagent/active, .superagent/config.json, or the .superagent dir itself? */
const touchesRuns = (tok) => {
  const n = posix.normalize(unquote(tok).replaceAll('\\', '/'));
  if (/(^|\/)\.superagent\/runs([/*?[]|$)/i.test(n)) return true;
  if (/(^|\/)\.superagent\/(active|config\.json)$/i.test(n)) return true;
  if (/(^|\/)\.superagent\/*$/i.test(n)) return true; // the parent dir: removing or moving it takes runs/ with it
  const g = /(^|\/)\.superagent\/([^/]*[*?[][^/]*)/i.exec(n);
  return Boolean(g) && globMatchesState(g[2]);
};

const NAMING_COMMANDS = new Set(['rm', 'mv', 'rmdir', 'unlink', 'truncate', 'touch', 'ln', 'shred', 'tee']);

/** Does this command part write to, or remove, something under .superagent/runs/ (ignoring redirections)? */
function partWritesRuns(toks, at) {
  if (!toks.length) return false;
  const [cmd, ...args] = toks;
  const operands = args.filter((a) => !a.startsWith('-'));
  const hit = (list) => list.some((o) => touchesRuns(at(o)));
  if (NAMING_COMMANDS.has(cmd)) return hit(operands);
  if (cmd === 'cp' || cmd === 'install') return hit(operands.slice(-1));
  if (cmd === 'sed' && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place='))) return hit(operands);
  if (cmd === 'dd') return hit(args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)));
  return false;
}

const REDIRECT = /&?\d*>>?\|?\s*["']?([^\s"';&|<>()]+)/g;

function bashWritesRuns(command, parts) {
  // Redirections anywhere in the line, relative to the starting directory.
  for (const m of command.matchAll(REDIRECT)) if (touchesRuns(m[1])) return true;
  // Track `cd` so relative operands are judged against where the command really runs.
  let cwd = null;
  const at = (o) => (cwd === null || o.startsWith('/') || o.startsWith('~') ? o : posix.normalize(`${cwd}/${o}`));
  for (const part of parts) {
    const toks = commandTokens(part);
    if (partWritesRuns(toks, at)) return true;
    if (cwd !== null) for (const m of part.matchAll(REDIRECT)) if (touchesRuns(at(unquote(m[1])))) return true;
    if ((toks[0] === 'cd' || toks[0] === 'pushd') && toks[1] && !toks[1].startsWith('-')) {
      cwd = toks[1].startsWith('/') || toks[1].startsWith('~') ? toks[1] : posix.normalize(`${cwd ?? '.'}/${toks[1]}`);
    }
  }
  return false;
}

/**
 * ctx: { command, run, config, fromWorker }. Outward actions are checked only while the run is guarded.
 * fromWorker: the caller is a worker or reviewer subagent (its cwd is a linked worktree, or its agent type
 * says so). Such a caller may not run orchestrator-only superagent commands, e.g. `cd <main> && superagent approve`.
 */
export function decideBash(ctx) {
  const { run } = ctx;
  if (typeof ctx.command !== 'string' || ctx.command === '') return ALLOW;
  const command = ctx.command.replace(/\\\r?\n/g, ''); // line continuations
  const parts = splitParts(command);

  if (bashWritesRuns(command, parts)) return deny(RUNS_REASON);
  if (ctx.fromWorker) {
    const orch = new Set();
    for (const p of parts) orchestratorCommands(p, orch);
    if (orch.size) {
      return deny(`Blocked: \`superagent ${[...orch][0]}\` is an orchestrator command; workers may run only ${[...WORKER_COMMANDS].join(', ')}. Put what you need in your report.`);
    }
  }
  if (!guarded(run)) return ALLOW;

  const allowedActions = new Set(run.allowed_actions ?? []);
  const found = new Set();
  for (const p of parts) outwardActions(p, found);
  const markers = (ctx.config?.production_markers ?? []).filter((m) => typeof m === 'string' && m !== '');
  const lowered = lower(command);
  if (markers.some((m) => lowered.includes(lower(m)))) found.add('production');

  if (found.has('clean-x')) {
    return deny('Blocked: `git clean -x/-X` would delete the git-ignored .superagent/ directory. Run state is changed only through the superagent CLI.');
  }
  if (found.has('stash-all')) {
    return deny('Blocked: `git stash -a/--all` would stash away the git-ignored .superagent/ directory and worker worktrees. Run state is changed only through the superagent CLI.');
  }
  for (const action of ['push', 'deploy', 'publish', 'production']) {
    if (found.has(action) && !allowedActions.has(action)) {
      return deny(`Blocked: \`${action}\` is not in this run's approved Charter. Ask the user; a Charter revision can allow it.`);
    }
  }
  return ALLOW;
}
