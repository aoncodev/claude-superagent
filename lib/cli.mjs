import { activeRunId, loadRun } from './state.mjs';
import { mainRoot } from './git.mjs';
import { StateError, UsageError } from './errors.mjs';

/**
 * Hand-written argv parser. `--flag value`, `--flag=value`, and boolean flags
 * (those named in `booleans`, or a flag followed by another flag / end of args).
 * Returns { positional: string[], flags: { [name]: string | true } }.
 */
export function parseArgs(argv, booleans = []) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') || a === '--') {
      if (a !== '--') positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (booleans.includes(name) || next === undefined || next.startsWith('--')) flags[name] = true;
    else { flags[name] = next; i++; }
  }
  return { positional, flags };
}

/** Value of a string flag, or undefined. Throws UsageError if given without a value. */
export function strFlag(args, name) {
  const v = args.flags[name];
  if (v === undefined) return undefined;
  if (v === true || v === '') throw new UsageError(`--${name} requires a value`);
  return v;
}

/** Per-invocation context handed to every command handler. */
export function makeContext(cwd) {
  const ctx = {
    cwd,
    /** Absolute path of the main checkout; UsageError outside a git repository. */
    root() {
      try {
        return mainRoot(cwd);
      } catch {
        throw new UsageError('not inside a git repository (superagent init --title <t> --git-init creates one)');
      }
    },
    /** Resolve --run <id> or the active run. Returns { root, run }. */
    resolveRun(args) {
      const root = ctx.root();
      const id = strFlag(args, 'run') ?? activeRunId(root);
      if (!id) throw new StateError('no active run (start one with `superagent init --title <t>`, or pass --run <id>)');
      return { root, run: loadRun(root, id) };
    },
  };
  return ctx;
}
