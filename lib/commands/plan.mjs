import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { RefusalError, StateError, UsageError } from '../errors.mjs';
import {
  appendEvent, charterPath, loadTickets, readCharter, readConfig, saveRun, saveTicket, writeAtomic,
} from '../state.mjs';
import {
  normalizeRel, parseCharter, renderCharter, renderProposal, validateCharter, validatePlan,
} from '../plan.mjs';

const norm = (list) => (list ?? []).map(normalizeRel);

function readFileArg(args, ctx, cmd, what) {
  const [file] = args.positional;
  if (!file) throw new UsageError(`usage: superagent ${cmd} <${what}>`);
  const path = resolve(ctx.cwd, file);
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read ${path}: ${e.code ?? e.message}`);
  }
}

function propose(args, ctx) {
  const text = readFileArg(args, ctx, 'propose', 'plan.json');
  let plan;
  try {
    plan = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`plan file is not valid JSON: ${e.message}`);
  }
  const { root, run } = ctx.resolveRun(args);
  if (run.charter_sha256 !== null || run.integration_branch !== null || !['proposing', 'awaiting_approval'].includes(run.phase)) {
    throw new RefusalError(`cannot propose: run ${run.id} is past approval (phase ${run.phase}); use \`superagent revise-charter <file>\` to change the Charter`);
  }
  const errors = validatePlan(plan);
  if (errors.length) {
    throw new UsageError(`plan is invalid (${errors.length} error${errors.length === 1 ? '' : 's'}):\n${errors.map((e) => `- ${e}`).join('\n')}`);
  }

  // Normalize what gets stored: paths in POSIX form, defaults filled in.
  const contracts = (plan.contracts ?? []).map((c) => ({ id: c.id, title: c.title, path: normalizeRel(c.path) }));
  const tickets = plan.tickets.map((t) => ({
    id: t.id,
    title: t.title,
    kind: t.kind,
    wave: t.wave,
    scope: t.scope,
    owns: norm(t.owns),
    reads: norm(t.reads),
    contracts: [...(t.contracts ?? [])],
    done_when: [...(t.done_when ?? [])],
    status: 'planned',
    origin: 'plan',
    agent_id: null,
    worktree: null,
    branch: null,
    attempts: 0,
    answer: null,
  }));
  const project = {
    kind: plan.project.kind,
    stack: plan.project.stack ?? null,
    setup: [...(plan.project.setup ?? [])],
    checks: [...(plan.project.checks ?? [])],
    integration_checks: [...(plan.project.integration_checks ?? [])],
  };
  const allowed = [...new Set(plan.charter.allowed_actions ?? [])];
  const parallelism = plan.parallelism ?? readConfig(root).parallelism;

  // Replace any earlier proposal wholesale, then write the new one; run.json goes last.
  const ticketsDir = join(dirname(charterPath(root, run)), 'tickets');
  mkdirSync(ticketsDir, { recursive: true });
  for (const f of readdirSync(ticketsDir)) if (/^T\d+\.json$/.test(f)) rmSync(join(ticketsDir, f));
  for (const t of tickets) saveTicket(root, run.id, t);
  writeFileSync(join(dirname(charterPath(root, run)), 'contracts.json'), `${JSON.stringify(contracts, null, 2)}\n`);
  writeAtomic(charterPath(root, run), renderCharter({
    title: plan.title,
    rev: run.charter_rev,
    idea: plan.charter.idea,
    in_scope: plan.charter.in_scope,
    out_of_scope: plan.charter.out_of_scope,
    allowed_actions: allowed,
  }));
  run.title = plan.title;
  run.project = project;
  run.allowed_actions = allowed;
  run.parallelism = parallelism;
  run.phase = 'awaiting_approval';
  saveRun(root, run);
  appendEvent(root, run.id, 'proposed', { tickets: tickets.length, contracts: contracts.length, waves: new Set(tickets.map((t) => t.wave)).size });

  console.log(renderProposal(run, { ...plan, title: plan.title, project, contracts, tickets, parallelism, charter: { ...plan.charter, allowed_actions: allowed } }));
}

function proposal(args, ctx) {
  const { root, run } = ctx.resolveRun(args);
  if (!existsSync(charterPath(root, run)) || !run.project) {
    throw new RefusalError(`run ${run.id} has no proposal yet (phase ${run.phase}); write a plan and run \`superagent propose <plan.json>\``);
  }
  const charter = parseCharter(readCharter(root, run));
  if (!charter) throw new StateError(`cannot parse ${charterPath(root, run)}`);
  const contractsFile = join(dirname(charterPath(root, run)), 'contracts.json');
  const contracts = existsSync(contractsFile) ? JSON.parse(readFileSync(contractsFile, 'utf8')) : [];
  console.log(renderProposal(run, {
    title: run.title,
    charter,
    project: run.project,
    contracts,
    tickets: loadTickets(root, run.id),
    parallelism: run.parallelism,
  }));
}

/**
 * A new Charter revision from a plain-text idea file (scope lines and allowed actions are kept), or from a
 * `.json` file { idea, in_scope?, out_of_scope?, allowed_actions? } (omitted fields are kept). New allowed
 * actions take effect only when the user approves the revision.
 */
function reviseCharter(args, ctx) {
  const text = readFileArg(args, ctx, 'revise-charter', 'idea-file | charter.json');
  const { root, run } = ctx.resolveRun(args);
  if (run.charter_sha256 === null) {
    throw new RefusalError(`cannot revise: the Charter of ${run.id} is not approved yet (phase ${run.phase}); re-run \`superagent propose\` instead`);
  }
  if (['done', 'aborted'].includes(run.phase)) throw new RefusalError(`cannot revise: run ${run.id} is ${run.phase}`);
  const old = parseCharter(readCharter(root, run));
  if (!old) throw new StateError(`cannot parse ${charterPath(root, run)}`);
  let charter;
  if (args.positional[0].toLowerCase().endsWith('.json')) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new UsageError(`charter file is not valid JSON: ${e.message}`);
    }
    const errors = validateCharter(data);
    if (errors.length) throw new UsageError(`charter is invalid (${errors.length} error${errors.length === 1 ? '' : 's'}):\n${errors.map((e) => `- ${e}`).join('\n')}`);
    charter = {
      idea: data.idea,
      in_scope: data.in_scope ?? old.in_scope,
      out_of_scope: data.out_of_scope ?? old.out_of_scope,
      allowed_actions: [...new Set(data.allowed_actions ?? old.allowed_actions)],
    };
  } else {
    if (text.trim() === '') throw new UsageError('revise-charter: the idea file is empty');
    charter = { idea: text, in_scope: old.in_scope, out_of_scope: old.out_of_scope, allowed_actions: old.allowed_actions };
  }
  const rev = run.charter_rev + 1;
  const next = { ...run, charter_rev: rev };
  writeAtomic(charterPath(root, next), renderCharter({ title: run.title, rev, ...charter }));
  const from = run.phase;
  run.charter_rev = rev;
  run.charter_sha256 = null;
  run.phase = 'awaiting_approval';
  saveRun(root, run);
  appendEvent(root, run.id, 'charter_revised', { rev, from });
  console.log(`charter r${rev} written for ${run.id}; awaiting approval (was ${from})`);
}

export default { propose, proposal, 'revise-charter': reviseCharter };
