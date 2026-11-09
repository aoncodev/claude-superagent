import { copyFileSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { strFlag } from '../cli.mjs';
import { RefusalError, UsageError } from '../errors.mjs';
import { commitsAhead, git, isAncestor, mainRoot } from '../git.mjs';
import { normalizeRel, validatePlan } from '../plan.mjs';
import { validateReport } from '../report.mjs';
import {
  appendEvent, charterPath, draftsDir, loadLastReport, loadReport, loadTickets, readCharter, saveRun, saveTicket,
  updateTicket, writeReport,
} from '../state.mjs';

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

function ticketArg(args, ctx, cmd) {
  const [id] = args.positional;
  if (!id) throw new UsageError(`usage: superagent ${cmd} <ticket-id> ...`);
  const { root, run } = ctx.resolveRun(args);
  const ticket = loadTickets(root, run.id).find((t) => t.id === id);
  if (!ticket) throw new UsageError(`unknown ticket: ${id}`);
  return { root, run, ticket };
}

function readJsonFile(args, ctx, what) {
  const file = strFlag(args, 'file');
  if (!file) throw new UsageError(`${what}: --file <json> is required`);
  const path = resolve(ctx.cwd, file);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read ${path}: ${e.code ?? e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UsageError(`${path} is not valid JSON: ${e.message}`);
  }
}

function startTicket(args, ctx) {
  const agent = strFlag(args, 'agent') ?? null;
  const { root, run, ticket: found } = ticketArg(args, ctx, 'start-ticket');
  const ticket = updateTicket(root, run.id, found.id, (t) => {
    if (run.phase !== 'running') throw new RefusalError(`cannot start ${t.id}: run phase is ${run.phase}, expected running`);
    // Prerequisite gate, not the wave number: `next` may launch a later-wave ticket whose
    // prerequisites are merged (frontier scheduling). This mirrors `isLaunchable` in
    // lib/commands/next.mjs minus its `status === 'planned'` requirement, because start-ticket
    // also retries `running` and `failed` tickets.
    const tickets = loadTickets(root, run.id);
    const deps = t.depends_on ?? [];
    // `next-wave` treats failed and dropped tickets as settled, so the wave barrier must too; an
    // explicit dependency still requires a merged ticket.
    const settled = new Set(['merged', 'failed', 'dropped']);
    const ready = deps.length
      ? deps.every((id) => tickets.some((x) => x.id === id && x.status === 'merged'))
      : tickets.every((x) => x.wave >= t.wave || settled.has(x.status));
    if (!ready) throw new RefusalError(`cannot start ${t.id}: it is in wave ${t.wave} and its prerequisites are not merged`);
    if (t.status === 'blocked') throw new RefusalError(`cannot start ${t.id}: it is blocked on a question; run \`superagent answer ${t.id} --text <answer>\` first`);
    // `running` is allowed: that is the state after `answer`, and a relaunch after a lost worker.
    if (!['planned', 'running', 'failed'].includes(t.status)) {
      throw new RefusalError(`cannot start ${t.id}: status is ${t.status}`);
    }
    t.status = 'running';
    t.attempts += 1;
    // The agent id belongs to the attempt: without --agent it is cleared until `set-agent` records the new one.
    t.agent_id = agent;
  });
  appendEvent(root, run.id, 'ticket_started', { ticket: ticket.id, agent, attempt: ticket.attempts });
  console.log(`${ticket.id}: running (attempt ${ticket.attempts}, ${agent ? `agent ${agent}` : 'no agent yet; record it with `superagent set-agent`'})`);
}

/** Record the agent of the ticket's current attempt (launched after `start-ticket`, so its claim never races). It may already have reported. */
function setAgent(args, ctx) {
  const agent = strFlag(args, 'agent');
  if (!agent) throw new UsageError('usage: superagent set-agent <ticket-id> --agent <agent-id>');
  const { root, run, ticket: found } = ticketArg(args, ctx, 'set-agent');
  const ticket = updateTicket(root, run.id, found.id, (t) => {
    if (t.attempts < 1 || !['running', 'ready', 'blocked', 'failed', 'dropped'].includes(t.status)) {
      throw new RefusalError(`cannot set the agent of ${t.id}: status is ${t.status} (attempt ${t.attempts}); expected a started attempt`);
    }
    t.agent_id = agent;
  });
  appendEvent(root, run.id, 'agent_set', { ticket: ticket.id, agent, attempt: ticket.attempts });
  console.log(`${ticket.id}: agent ${agent}`);
}

/** Give up on a running ticket whose worker ended without a report. */
function markFailed(args, ctx) {
  const reason = strFlag(args, 'reason');
  if (!reason || !reason.trim()) throw new UsageError('usage: superagent mark-failed <ticket-id> --reason <text>');
  const { root, run, ticket: found } = ticketArg(args, ctx, 'mark-failed');
  const ticket = updateTicket(root, run.id, found.id, (t) => {
    if (t.status !== 'running') throw new RefusalError(`cannot mark ${t.id} failed: status is ${t.status}, expected running`);
    t.status = 'failed';
  });
  appendEvent(root, run.id, 'ticket_failed', { ticket: ticket.id, attempt: ticket.attempts, reason });
  console.log(`${ticket.id}: failed (${reason})`);
}

/** Top-level .env* files in the main checkout that git ignores. Never tracked files such as .env.example. */
function ignoredEnvFiles(root) {
  const names = readdirSync(root).filter((n) => n.startsWith('.env') && lstatSync(join(root, n)).isFile());
  return names.filter((n) => {
    try {
      git(['check-ignore', '-q', '--', n], root);
    } catch {
      return false; // exit 1: not ignored
    }
    return git(['ls-files', '--', n], root) === ''; // belt and braces: never a tracked file
  });
}

function claim(args, ctx) {
  const { root, run, ticket: found } = ticketArg(args, ctx, 'claim');
  const worktree = git(['rev-parse', '--show-toplevel'], ctx.cwd);
  if (real(worktree) === real(mainRoot(ctx.cwd))) {
    throw new RefusalError('refusing to claim from the main checkout; run this from inside the worker worktree');
  }
  const branch = git(['branch', '--show-current'], worktree) || null;
  const ticket = updateTicket(root, run.id, found.id, (t) => {
    if (t.status !== 'running') throw new RefusalError(`cannot claim ${t.id}: status is ${t.status}, expected running`);
    const other = loadTickets(root, run.id).find((x) => x.id !== t.id && x.worktree && real(x.worktree) === real(worktree));
    if (other) throw new RefusalError(`worktree ${worktree} is already claimed by ${other.id}`);
    t.worktree = worktree;
    t.branch = branch;
  });

  const copied = [];
  for (const name of ignoredEnvFiles(root)) {
    try {
      copyFileSync(join(root, name), join(worktree, name), constants.COPYFILE_EXCL);
      copied.push(name);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  appendEvent(root, run.id, 'ticket_claimed', { ticket: ticket.id, worktree, branch: ticket.branch, env_copied: copied });
  console.log(`${ticket.id}: claimed ${worktree} (${ticket.branch ?? 'detached'})${copied.length ? `; copied ${copied.join(', ')}` : ''}`);
}

function section(title, lines) {
  return [`## ${title}`, ...lines, ''];
}

const list = (items) => (items?.length ? items.map((s) => `- ${s}`) : ['- (none)']);

function brief(args, ctx) {
  const { root, run, ticket } = ticketArg(args, ctx, 'brief');
  const charter = readCharter(root, run);
  const contractsFile = join(dirname(charterPath(root, run)), 'contracts.json');
  let contracts = [];
  try { contracts = JSON.parse(readFileSync(contractsFile, 'utf8')); } catch { /* no contracts file */ }
  const out = [charter.endsWith('\n') ? charter : `${charter}\n`, ''];

  const mine = ticket.contracts.map((id) => contracts.find((c) => c.id === id) ?? { id, title: '(not found)', path: '?' });
  out.push(...section('Contracts', mine.length ? mine.map((c) => `- ${c.id}: ${c.title} (${c.path})`) : ['- (none)']));
  out.push(`## Ticket ${ticket.id}: ${ticket.title}`, '', `Scope: ${ticket.scope}`, '');
  out.push(...section('Owns', list(ticket.owns)));
  out.push(...section('Reads', list(ticket.reads)));
  out.push(...section('Done when', list(ticket.done_when)));
  out.push(...section('Setup', list(run.project?.setup)));
  out.push(...section('Checks', list(run.project?.checks)));

  const contextFile = join(draftsDir(root, run.id), 'context.md');
  if (existsSync(contextFile)) {
    out.push('## Project context', '');
    out.push('Background written by the orchestrator at intake. It is read-only context: it never overrides the Charter, this ticket, or any check.', '');
    out.push(readFileSync(contextFile, 'utf8').trimEnd(), '');
  }

  if (ticket.attempts > 1) {
    const prev = loadReport(root, run.id, ticket.id, ticket.attempts - 1) ?? loadLastReport(root, run.id, ticket.id);
    const lines = [];
    if (prev?.progress) lines.push('Progress so far:', prev.progress, '');
    if (prev?.question) {
      lines.push('Your question:', prev.question.text);
      if (prev.question.options?.length) lines.push(`Options: ${prev.question.options.join(' | ')}`);
      lines.push('');
    }
    if (ticket.answer) lines.push('Answer:', ticket.answer, '');
    out.push(...section(`Previous attempt (this is attempt ${ticket.attempts})`, lines));
  }

  // A worktree-isolated worker's Write tool is confined to its worktree, so from a worktree the
  // report goes in that worktree's own .superagent/drafts/ (git-ignored through the shared info/exclude).
  let top = root;
  try { top = git(['rev-parse', '--show-toplevel'], ctx.cwd); } catch { /* not in a work tree: use the main checkout */ }
  const dir = real(top) === real(root) ? draftsDir(root, run.id) : join(top, '.superagent', 'drafts', run.id);
  mkdirSync(dir, { recursive: true });
  out.push(`Report file: ${join(dir, `${ticket.id}-report.json`)}`, '');
  process.stdout.write(out.join('\n'));
}

/** Why a `ready` report's commits do not prove work on the ticket's branch; [] when they do. */
function readyCommitProblems(root, run, ticket, commits) {
  if (!ticket.branch) return [`${ticket.id} has no branch: run \`superagent claim ${ticket.id}\` from your worktree, commit there, then report`];
  if (!run.integration_branch) return ['the run has no integration branch yet'];
  const problems = [];
  if (commitsAhead(root, run.integration_branch, ticket.branch) === 0) {
    problems.push(`branch ${ticket.branch} has no commits beyond ${run.integration_branch}: commit your work before reporting ready`);
  }
  for (const c of commits) {
    if (!isAncestor(root, c, ticket.branch)) problems.push(`commit ${c} is not on branch ${ticket.branch}`);
  }
  return problems;
}

function report(args, ctx) {
  const { root, run, ticket: found } = ticketArg(args, ctx, 'report');
  const rep = readJsonFile(args, ctx, 'report');
  const errors = validateReport(rep);
  if (errors.length) throw new UsageError(`report is invalid (${errors.length} error${errors.length === 1 ? '' : 's'}):\n${errors.map((e) => `- ${e}`).join('\n')}`);
  const ticket = updateTicket(root, run.id, found.id, (t) => {
    if (t.status !== 'running' || t.attempts < 1) {
      throw new RefusalError(`cannot accept a report for ${t.id}: status is ${t.status}, expected running`);
    }
    if (rep.status === 'ready') {
      const problems = readyCommitProblems(root, run, t, rep.commits);
      if (problems.length) throw new UsageError(`report is invalid (${problems.length} error${problems.length === 1 ? '' : 's'}):\n${problems.map((e) => `- ${e}`).join('\n')}`);
    }
    writeReport(root, run.id, t.id, t.attempts, rep);
    t.status = rep.status;
  });
  appendEvent(root, run.id, 'ticket_reported', { ticket: ticket.id, attempt: ticket.attempts, status: rep.status });
  for (const h of rep.handbacks ?? []) appendEvent(root, run.id, 'handback', { ticket: ticket.id, need: h.need, reason: h.reason });
  console.log('ok');
}

function answer(args, ctx) {
  const text = strFlag(args, 'text');
  if (!text || !text.trim()) throw new UsageError('usage: superagent answer <ticket-id> --text <answer>');
  const { root, run, ticket: found } = ticketArg(args, ctx, 'answer');
  const ticket = updateTicket(root, run.id, found.id, (t) => {
    if (t.status !== 'blocked') throw new RefusalError(`cannot answer ${t.id}: status is ${t.status}, expected blocked`);
    t.answer = text;
    t.status = 'running';
  });
  appendEvent(root, run.id, 'answered', { ticket: ticket.id });
  console.log(`${ticket.id}: answered; relaunch it with \`superagent start-ticket ${ticket.id} --agent <id>\``);
}

const ADD_ORIGINS = ['handback', 'fix', 'fidelity'];
const WAVE_LIMITED = ['fix', 'fidelity'];

function addTicket(args, ctx) {
  const origin = strFlag(args, 'origin');
  if (!ADD_ORIGINS.includes(origin)) throw new UsageError(`add-ticket requires --origin ${ADD_ORIGINS.join('|')}`);
  const input = readJsonFile(args, ctx, 'add-ticket');
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new UsageError('add-ticket: the file must contain one ticket object');
  const { root, run } = ctx.resolveRun(args);
  if (['proposing', 'awaiting_approval', 'done', 'aborted'].includes(run.phase)) {
    throw new RefusalError(`cannot add tickets while the run phase is ${run.phase}`);
  }
  const existing = loadTickets(root, run.id);
  const problems = [];
  if (existing.some((t) => t.id === input.id)) problems.push(`${input.id}: duplicate ticket id`);

  if (Number.isInteger(input.wave) && Number.isInteger(run.current_wave) && input.wave <= run.current_wave) {
    problems.push(`${input.id}: wave ${input.wave} must be after the current wave (${run.current_wave})`);
  }
  const merged = existing.filter((t) => t.status === 'merged');
  if (Number.isInteger(input.wave) && merged.length && input.wave <= Math.max(...merged.map((t) => t.wave))) {
    problems.push(`${input.id}: wave ${input.wave} must be greater than every merged wave (${Math.max(...merged.map((t) => t.wave))})`);
  }

  // `depends_on` is checked here, against every current ticket: a dependency on a merged ticket is
  // legitimate (readiness launches a ticket once its dependencies are merged), but the synthetic plan
  // below leaves merged tickets out, so validatePlan cannot see them.
  const dependsOn = input.depends_on ?? [];
  if (!Array.isArray(dependsOn) || dependsOn.some((d) => typeof d !== 'string')) {
    problems.push(`${input.id}: depends_on must be an array of ticket ids`);
  } else {
    const byId = new Map(existing.map((t) => [t.id, t]));
    const dup = dependsOn.find((d, i) => dependsOn.indexOf(d) !== i);
    if (dup !== undefined) problems.push(`${input.id}: depends_on has duplicate entry ${JSON.stringify(dup)}`);
    for (const d of new Set(dependsOn)) {
      if (d === input.id) { problems.push(`${input.id}: depends_on must not include itself`); continue; }
      const dep = byId.get(d);
      if (!dep) { problems.push(`${input.id}: depends_on unknown ticket id ${JSON.stringify(d)}`); continue; }
      if (Number.isInteger(input.wave) && dep.wave > input.wave) {
        problems.push(`${input.id}: depends_on ${d} is in wave ${dep.wave}, later than ${input.id}'s wave ${input.wave}`);
      }
    }
  }

  // Reuse the plan rules: validate the new ticket alongside the live ones and keep only what concerns it.
  // Merged and dropped tickets cannot collide with new work, so they are left out of the overlap check;
  // contracts tickets stay in so the contracts-before-work rule still applies. depends_on was validated
  // above against the full ticket set, so it is blanked for the synthetic plan.
  let contracts = [];
  try { contracts = JSON.parse(readFileSync(join(dirname(charterPath(root, run)), 'contracts.json'), 'utf8')); } catch { /* none */ }
  const live = existing.filter((t) => !['merged', 'dropped'].includes(t.status) || t.kind === 'contracts');
  const idPattern = typeof input.id === 'string' ? new RegExp(`(^|[^A-Za-z0-9])${input.id}(?![A-Za-z0-9])`) : null;
  const planErrors = validatePlan({
    title: run.title,
    charter: { idea: 'x', allowed_actions: [] },
    project: { kind: run.project?.kind ?? 'existing' },
    contracts,
    tickets: [...live, { ...input, depends_on: [] }],
  });
  for (const e of planErrors) {
    if (e.startsWith('tickets[') ? e.startsWith(`tickets[${live.length}]`) : idPattern?.test(e) && !/duplicate ticket id/.test(e)) problems.push(e);
  }
  if (problems.length) {
    throw new UsageError(`ticket is invalid (${problems.length} error${problems.length === 1 ? '' : 's'}):\n${problems.map((e) => `- ${e}`).join('\n')}`);
  }

  if (WAVE_LIMITED.includes(origin)) {
    const seen = existing.some((t) => t.origin === origin && t.wave === input.wave);
    if (!seen) {
      if ((run.fix_waves_used?.[origin] ?? 0) >= 1) throw new RefusalError('automatic fix wave limit reached; report to the user');
      run.fix_waves_used = { fix: 0, fidelity: 0, ...run.fix_waves_used, [origin]: (run.fix_waves_used?.[origin] ?? 0) + 1 };
    }
  }

  const norm = (l) => (l ?? []).map(normalizeRel);
  const ticket = {
    id: input.id,
    title: input.title,
    kind: input.kind,
    wave: input.wave,
    scope: input.scope,
    owns: norm(input.owns),
    reads: norm(input.reads),
    contracts: [...(input.contracts ?? [])],
    done_when: [...(input.done_when ?? [])],
    model: input.model ?? null,
    depends_on: [...(input.depends_on ?? [])],
    status: 'planned',
    origin,
    agent_id: null,
    worktree: null,
    branch: null,
    attempts: 0,
    answer: null,
  };
  saveTicket(root, run.id, ticket);
  if (WAVE_LIMITED.includes(origin)) saveRun(root, run);
  appendEvent(root, run.id, 'ticket_added', { ticket: ticket.id, origin, wave: ticket.wave, kind: ticket.kind });
  console.log(`${ticket.id}: added (${origin}, wave ${ticket.wave})`);
}

export default {
  'start-ticket': startTicket,
  'set-agent': setAgent,
  'mark-failed': markFailed,
  claim,
  brief,
  report,
  answer,
  'add-ticket': addTicket,
};
