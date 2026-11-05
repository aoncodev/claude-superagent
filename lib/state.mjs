import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { git } from './git.mjs';
import { StateError } from './errors.mjs';

export { StateError };

export const PHASES = ['proposing', 'awaiting_approval', 'running', 'merging', 'verifying', 'reviewing', 'done', 'aborted'];
export const EXCLUDE_LINES = ['.superagent/', '.claude/worktrees/'];

const DEFAULT_CONFIG = { parallelism: 4, production_markers: [], worker_model: 'inherit' };

export function stateDir(root) {
  return join(root, '.superagent');
}

function runDir(root, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes('..')) {
    throw new StateError(`invalid run id: ${JSON.stringify(id)}`);
  }
  return join(stateDir(root), 'runs', id);
}

export function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function readJson(file, what) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new StateError(`cannot read ${what} (${file}): ${e.code ?? e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new StateError(`invalid JSON in ${what} (${file}): ${e.message}`);
  }
}

/** Create .superagent/ and keep it, plus Claude Code's worker worktrees, out of git status. */
export function ensureStateDir(root) {
  mkdirSync(stateDir(root), { recursive: true });
  const exclude = git(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], root);
  mkdirSync(join(exclude, '..'), { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  const have = new Set(current.split('\n'));
  const missing = EXCLUDE_LINES.filter((l) => !have.has(l));
  if (missing.length) {
    const sep = current === '' || current.endsWith('\n') ? '' : '\n';
    appendFileSync(exclude, `${sep}${missing.join('\n')}\n`);
  }
}

export function readConfig(root) {
  const file = join(stateDir(root), 'config.json');
  if (!existsSync(file)) return { ...DEFAULT_CONFIG, production_markers: [] };
  const raw = readJson(file, 'config.json');
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new StateError(`config.json must be a JSON object (${file})`);
  const cfg = { ...DEFAULT_CONFIG, production_markers: [] };
  if (raw.parallelism !== undefined) {
    if (!Number.isInteger(raw.parallelism) || raw.parallelism < 1 || raw.parallelism > 8) {
      throw new StateError(`config.json: parallelism must be an integer from 1 to 8 (${file})`);
    }
    cfg.parallelism = raw.parallelism;
  }
  if (raw.production_markers !== undefined) {
    if (!Array.isArray(raw.production_markers) || raw.production_markers.some((m) => typeof m !== 'string')) {
      throw new StateError(`config.json: production_markers must be an array of strings (${file})`);
    }
    cfg.production_markers = raw.production_markers;
  }
  if (raw.worker_model !== undefined) {
    if (typeof raw.worker_model !== 'string' || !raw.worker_model) throw new StateError(`config.json: worker_model must be a non-empty string (${file})`);
    cfg.worker_model = raw.worker_model;
  }
  return cfg;
}

const pad = (n) => String(n).padStart(2, '0');

function slugify(title) {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');
  return slug || 'run';
}

export function createRun(root, { title }) {
  ensureStateDir(root);
  const config = readConfig(root);
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const base = `${stamp}-${slugify(title)}`;
  let id = base;
  for (let n = 2; existsSync(runDir(root, id)); n++) id = `${base}-${n}`;
  const run = {
    id,
    title,
    phase: 'proposing',
    created_at: now.toISOString(),
    repo_root: root,
    charter_rev: 1,
    charter_sha256: null,
    allowed_actions: [],
    project: null,
    parallelism: config.parallelism,
    base_branch: null,
    base_sha: null,
    integration_branch: null,
    current_wave: null,
    fix_waves_used: { fix: 0, fidelity: 0 },
  };
  mkdirSync(join(runDir(root, id), 'tickets'), { recursive: true });
  saveRun(root, run);
  writeAtomic(join(stateDir(root), 'active'), `${id}\n`);
  appendEvent(root, id, 'created', { title });
  return run;
}

export function activeRunId(root) {
  const file = join(stateDir(root), 'active');
  if (!existsSync(file)) return null;
  const id = readFileSync(file, 'utf8').trim();
  return id || null;
}

export function loadRun(root, id) {
  const file = join(runDir(root, id), 'run.json');
  const run = readJson(file, 'run.json');
  if (run === null || typeof run !== 'object' || typeof run.id !== 'string' || !PHASES.includes(run.phase)) {
    throw new StateError(`run.json is not a valid run (${file})`);
  }
  return run;
}

export function saveRun(root, run) {
  mkdirSync(runDir(root, run.id), { recursive: true });
  writeAtomic(join(runDir(root, run.id), 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
}

const ticketNum = (t) => Number(String(t.id).slice(1));

export function loadTickets(root, id) {
  const dir = join(runDir(root, id), 'tickets');
  if (!existsSync(dir)) return [];
  const tickets = readdirSync(dir)
    .filter((f) => /^T\d+\.json$/.test(f))
    .map((f) => readJson(join(dir, f), `ticket ${f}`));
  return tickets.sort((a, b) => (a.wave - b.wave) || (ticketNum(a) - ticketNum(b)));
}

export function saveTicket(root, id, t) {
  if (typeof t?.id !== 'string' || !/^T\d+$/.test(t.id)) throw new StateError(`invalid ticket id: ${JSON.stringify(t?.id)}`);
  const dir = join(runDir(root, id), 'tickets');
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, `${t.id}.json`), `${JSON.stringify(t, null, 2)}\n`);
}

export function appendEvent(root, id, type, data = {}) {
  mkdirSync(runDir(root, id), { recursive: true });
  appendFileSync(join(runDir(root, id), 'events.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), type, ...data })}\n`);
}

export function charterPath(root, run) {
  return join(runDir(root, run.id), `charter.r${run.charter_rev}.md`);
}

export function readCharter(root, run) {
  const file = charterPath(root, run);
  try {
    return readFileSync(file, 'utf8');
  } catch {
    throw new StateError(`charter file not found: ${file}`);
  }
}
