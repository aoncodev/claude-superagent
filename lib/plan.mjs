// Plan validation, path-ownership rules, and rendering of the split proposal / charter.
// Owned paths are repo-relative POSIX prefixes (never globs): "dir/" owns everything under
// dir; "name" owns that exact file and, if it is a directory, everything under it.

export const ACTIONS = ['push', 'deploy', 'publish', 'production'];
export const KINDS = ['scaffold', 'contracts', 'work', 'fix'];
export const BLOCKED_LINE = 'none — push, deploy, publish and production access are blocked';

/**
 * Normalize a repo-relative path: POSIX separators, no "." segments, ".." collapsed.
 * A trailing "/" is preserved (it matters to ownsPath). Returns null for absolute paths,
 * paths escaping the root, empty paths, the bare root, and non-strings.
 */
export function normalizeRel(p) {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) return null;
  p = p.replaceAll('\\', '/');
  if (p.startsWith('/')) return null;
  const trailing = p.endsWith('/');
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  if (out.length === 0) return null;
  return out.join('/') + (trailing ? '/' : '');
}

/** True when owned entry `e` (normalized) covers path `f` (normalized, may end in "/"). */
function covers(e, f) {
  if (e.endsWith('/')) return f.startsWith(e);
  return f === e || f.startsWith(`${e}/`);
}

/** Does any entry in `owns` own the path `rel`? Compares whole path segments. */
export function ownsPath(owns, rel) {
  const f = normalizeRel(rel);
  if (f === null || !Array.isArray(owns)) return false;
  return owns.some((e) => {
    const n = normalizeRel(e);
    return n !== null && covers(n, f);
  });
}

/** Pairs [x, y] (x from a, y from b) where one entry owns part of the other's territory. */
export function overlaps(a, b) {
  const pairs = [];
  for (const x of a) {
    const nx = normalizeRel(x);
    if (nx === null) continue;
    for (const y of b) {
      const ny = normalizeRel(y);
      if (ny === null) continue;
      if (covers(nx, ny) || covers(ny, nx)) pairs.push([x, y]);
    }
  }
  return pairs;
}

const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strArray = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');

/** Validate a plan. Returns every problem as one human-readable line; [] means valid. */
export function validatePlan(plan) {
  const errors = [];
  if (!isObj(plan)) return ['plan must be a JSON object'];

  if (!isStr(plan.title)) errors.push('plan.title must be a non-empty string');

  const charter = plan.charter;
  if (!isObj(charter)) {
    errors.push('plan.charter must be an object');
  } else {
    if (!isStr(charter.idea)) errors.push('charter.idea must be a non-empty string');
    for (const key of ['in_scope', 'out_of_scope']) {
      if (charter[key] !== undefined && !strArray(charter[key])) errors.push(`charter.${key} must be an array of strings`);
    }
    const acts = charter.allowed_actions ?? [];
    if (!strArray(acts)) errors.push('charter.allowed_actions must be an array of strings');
    else for (const a of acts) if (!ACTIONS.includes(a)) errors.push(`charter.allowed_actions: unknown action "${a}" (allowed: ${ACTIONS.join(', ')})`);
  }

  const project = plan.project;
  let projectKind = null;
  if (!isObj(project)) {
    errors.push('plan.project must be an object with kind "existing" or "new"');
  } else {
    if (project.kind !== 'existing' && project.kind !== 'new') errors.push(`project.kind must be "existing" or "new" (got ${JSON.stringify(project.kind)})`);
    else projectKind = project.kind;
    if (project.stack !== undefined && project.stack !== null && typeof project.stack !== 'string') errors.push('project.stack must be a string or null');
    for (const key of ['setup', 'checks', 'integration_checks']) {
      if (project[key] !== undefined && !strArray(project[key])) errors.push(`project.${key} must be an array of strings`);
    }
  }

  if (plan.parallelism !== undefined && (!Number.isInteger(plan.parallelism) || plan.parallelism < 1 || plan.parallelism > 8)) {
    errors.push(`parallelism must be an integer from 1 to 8 (got ${JSON.stringify(plan.parallelism)})`);
  }

  // Contracts
  const contractIds = new Set();
  if (plan.contracts !== undefined && !Array.isArray(plan.contracts)) {
    errors.push('plan.contracts must be an array');
  } else {
    for (const [i, c] of (plan.contracts ?? []).entries()) {
      if (!isObj(c)) { errors.push(`contracts[${i}] must be an object`); continue; }
      const label = typeof c.id === 'string' ? c.id : `contracts[${i}]`;
      if (typeof c.id !== 'string' || !/^C\d+$/.test(c.id)) errors.push(`${label}: contract id must match C<number>`);
      else if (contractIds.has(c.id)) errors.push(`${label}: duplicate contract id`);
      else contractIds.add(c.id);
      if (!isStr(c.title)) errors.push(`${label}: title must be a non-empty string`);
      if (normalizeRel(c.path) === null) errors.push(`${label}: path ${JSON.stringify(c.path)} must be a repo-relative path inside the repository`);
    }
  }

  // Tickets
  if (!Array.isArray(plan.tickets) || plan.tickets.length === 0) {
    errors.push('plan.tickets must be a non-empty array');
    return errors;
  }
  const ids = new Set();
  const valid = []; // tickets with usable id/wave/owns, for the cross-ticket rules
  for (const [i, t] of plan.tickets.entries()) {
    if (!isObj(t)) { errors.push(`tickets[${i}] must be an object`); continue; }
    const id = typeof t.id === 'string' ? t.id : `tickets[${i}]`;
    if (typeof t.id !== 'string' || !/^T\d+$/.test(t.id)) errors.push(`${id}: ticket id must match T<number>`);
    else if (ids.has(t.id)) errors.push(`${id}: duplicate ticket id`);
    else ids.add(t.id);
    if (!isStr(t.title)) errors.push(`${id}: title must be a non-empty string`);
    if (!KINDS.includes(t.kind)) errors.push(`${id}: kind must be one of ${KINDS.join(', ')} (got ${JSON.stringify(t.kind)})`);
    const waveOk = Number.isInteger(t.wave) && t.wave >= 0;
    if (!waveOk) errors.push(`${id}: wave must be an integer >= 0 (got ${JSON.stringify(t.wave)})`);
    if (!isStr(t.scope)) errors.push(`${id}: scope must be a non-empty string`);

    let ownsOk = false;
    if (!Array.isArray(t.owns) || t.owns.length === 0) {
      errors.push(`${id}: owns must be a non-empty array of paths`);
    } else {
      ownsOk = true;
      for (const e of t.owns) {
        if (typeof e !== 'string' || normalizeRel(e) === null) {
          errors.push(`${id}: owns entry ${JSON.stringify(e)} is not a repo-relative path inside the repository`);
          ownsOk = false;
        } else if (/[*?]/.test(e)) {
          errors.push(`${id}: owns entry ${JSON.stringify(e)} looks like a glob; use a file path or a directory ending in "/"`);
          ownsOk = false;
        }
      }
    }
    for (const key of ['reads', 'done_when']) {
      if (t[key] !== undefined && !strArray(t[key])) errors.push(`${id}: ${key} must be an array of strings`);
    }
    if (Array.isArray(t.reads)) {
      for (const r of t.reads) if (typeof r === 'string' && normalizeRel(r) === null) errors.push(`${id}: reads entry ${JSON.stringify(r)} is not a repo-relative path inside the repository`);
    }
    if (t.contracts !== undefined && !strArray(t.contracts)) errors.push(`${id}: contracts must be an array of contract ids`);
    else for (const c of t.contracts ?? []) if (!contractIds.has(c)) errors.push(`${id}: unknown contract id ${JSON.stringify(c)}`);

    if (t.kind === 'scaffold' && projectKind === 'existing') errors.push(`${id}: scaffold ticket is not allowed when project.kind is "existing"`);
    if (waveOk) valid.push({ id, kind: t.kind, wave: t.wave, owns: ownsOk ? t.owns : null });
  }

  // Same-wave ownership overlap
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const a = valid[i];
      const b = valid[j];
      if (a.wave !== b.wave || !a.owns || !b.owns) continue;
      for (const [x, y] of overlaps(a.owns, b.owns)) {
        errors.push(`${a.id} and ${b.id}: both in wave ${a.wave} and their owned paths overlap (${JSON.stringify(x)} vs ${JSON.stringify(y)})`);
      }
    }
  }

  // Scaffold runs alone
  for (const s of valid.filter((t) => t.kind === 'scaffold')) {
    for (const o of valid) {
      if (o !== s && o.wave === s.wave) errors.push(`${s.id}: scaffold ticket must be alone in its wave, but ${o.id} is also in wave ${s.wave}`);
    }
  }

  // A new project starts from exactly one scaffold ticket, in the lowest wave
  if (projectKind === 'new') {
    const scaffolds = valid.filter((t) => t.kind === 'scaffold');
    if (scaffolds.length !== 1) {
      errors.push(`project.kind is "new": the plan needs exactly one scaffold ticket (found ${scaffolds.length}${scaffolds.length ? `: ${scaffolds.map((t) => t.id).join(', ')}` : ''})`);
    }
    for (const s of scaffolds) {
      const earlier = valid.filter((o) => o.wave < s.wave);
      if (earlier.length) errors.push(`${s.id}: scaffold ticket must be in the lowest wave, but ${earlier.map((o) => o.id).join(', ')} come${earlier.length === 1 ? 's' : ''} before wave ${s.wave}`);
    }
  }

  // Contracts are settled before parallel work: work and fix tickets come strictly after every contracts ticket
  for (const w of valid.filter((t) => t.kind === 'work' || t.kind === 'fix')) {
    for (const c of valid.filter((t) => t.kind === 'contracts')) {
      if (w.wave <= c.wave) errors.push(`${w.id}: ${w.kind} ticket in wave ${w.wave} must come after contracts ticket ${c.id} (wave ${c.wave})`);
    }
  }
  return errors;
}

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const ticketNum = (t) => Number(String(t.id).slice(1));

function actionsLine(actions) {
  return actions.length ? `${actions.join(', ')} — all other outward actions are blocked` : BLOCKED_LINE;
}

function bullets(items, indent = '') {
  const clean = (items ?? []).map(oneLine).filter(Boolean);
  return clean.length ? clean.map((s) => `${indent}- ${s}`) : [`${indent}- (none)`];
}

/** The charter file text. The idea is written exactly as given: no trimming, no normalization. */
export function renderCharter({ title, rev = 1, idea, in_scope, out_of_scope, allowed_actions }) {
  return [
    `# Charter r${rev} — ${oneLine(title)}`,
    '',
    '## Idea (verbatim)',
    idea,
    '',
    '## In scope',
    ...bullets(in_scope),
    '',
    '## Out of scope',
    ...bullets(out_of_scope),
    '',
    '## Allowed outward actions',
    actionsLine(allowed_actions ?? []),
    '',
  ].join('\n');
}

/** Read back what renderCharter wrote. The idea is everything between its heading and the last "## In scope". */
export function parseCharter(text) {
  const head = '\n## Idea (verbatim)\n';
  const h = text.indexOf(head);
  const s = text.lastIndexOf('\n\n## In scope\n');
  if (h === -1 || s === -1 || s < h) return null;
  const idea = text.slice(h + head.length, s);
  const rest = text.slice(s + '\n\n## In scope\n'.length);
  const o = rest.indexOf('\n\n## Out of scope\n');
  const a = rest.indexOf('\n\n## Allowed outward actions\n');
  if (o === -1 || a === -1 || a < o) return null;
  const items = (block) => block.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2)).filter((l) => l !== '(none)');
  const actionText = rest.slice(a + '\n\n## Allowed outward actions\n'.length).trim();
  const names = actionText.startsWith('none —') ? [] : actionText.split(' — ')[0].split(',').map((x) => x.trim()).filter(Boolean);
  return {
    idea,
    in_scope: items(rest.slice(0, o)),
    out_of_scope: items(rest.slice(o, a)),
    allowed_actions: names,
  };
}

/** Human-readable split proposal. Roughly one screen for 12 tickets. */
export function renderProposal(run, plan) {
  const lines = [];
  const title = plan.title ?? run?.title ?? '(untitled)';
  const charter = plan.charter ?? {};
  lines.push(`Split proposal: ${oneLine(title)}`, '');
  lines.push('Charter');
  lines.push('  Idea:');
  for (const l of String(charter.idea ?? '').split('\n')) lines.push(`    > ${l}`);
  lines.push('  In scope:', ...bullets(charter.in_scope, '    '));
  lines.push('  Out of scope:', ...bullets(charter.out_of_scope, '    '));
  lines.push(`  Allowed outward actions: ${actionsLine(charter.allowed_actions ?? [])}`, '');

  const project = plan.project;
  if (project?.kind === 'new') {
    lines.push('Stack');
    lines.push(`  ${oneLine(project.stack ?? '(not specified)')}`);
    if (project.setup?.length) lines.push(`  Setup: ${project.setup.join('; ')}`);
    if (project.checks?.length) lines.push(`  Checks: ${project.checks.join('; ')}`);
    if (project.integration_checks?.length) lines.push(`  Integration checks: ${project.integration_checks.join('; ')}`);
    lines.push('');
  }

  if (plan.contracts?.length) {
    lines.push('Contracts');
    for (const c of plan.contracts) lines.push(`  ${c.id} · ${oneLine(c.title)} → ${c.path}`);
    lines.push('');
  }

  const byWave = new Map();
  for (const t of plan.tickets ?? []) {
    if (!byWave.has(t.wave)) byWave.set(t.wave, []);
    byWave.get(t.wave).push(t);
  }
  for (const wave of [...byWave.keys()].sort((x, y) => x - y)) {
    const ts = byWave.get(wave).sort((x, y) => ticketNum(x) - ticketNum(y));
    const label = ts.some((t) => t.kind === 'scaffold') ? 'scaffold' : ts.length > 1 ? 'parallel' : 'single';
    lines.push(`Wave ${wave} (${label})`);
    for (const t of ts) {
      lines.push(`  ${t.id} · ${oneLine(t.title)} — owns ${(t.owns ?? []).join(', ')}`);
      const scope = oneLine(t.scope ?? '');
      lines.push(`      ${scope.length > 150 ? `${scope.slice(0, 149)}…` : scope}`);
    }
    lines.push('');
  }
  lines.push(`Parallel workers: ${plan.parallelism ?? run?.parallelism ?? 4}`);
  return lines.join('\n');
}
