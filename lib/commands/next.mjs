// v0.2 orchestrator scheduler: `next` says the single next action for the orchestrator.
// Read-only: it never writes run or ticket state.
import { loadTickets } from '../state.mjs';

const CLOSED_PHASES = new Set(['done', 'aborted', 'proposing', 'awaiting_approval']);
const OPEN_STATUSES = ['planned', 'running', 'blocked', 'ready'];
// A lower-wave ticket that failed or was dropped is settled for scheduling, exactly as `next-wave`
// treats it (it only refuses while a wave has planned/running/blocked tickets). Otherwise a failed
// ticket in an earlier wave would make every later wave unlaunchable while `next` kept saying none.
const SETTLED = new Set(['merged', 'failed', 'dropped']);
const DEFAULT_PARALLELISM = 4;

const ticketNum = (t) => Number(String(t.id).slice(1));
const lowestFirst = (a, b) => ticketNum(a) - ticketNum(b);

const decision = (action, tickets = [], detail = '') => ({ action, tickets, detail });

/** True when `ticket` is planned and every prerequisite is merged. */
export function isLaunchable(ticket, tickets) {
  if (ticket.status !== 'planned') return false;
  const dependsOn = ticket.depends_on ?? [];
  if (dependsOn.length) {
    // Explicit edges replace the wave barrier but must all be merged; an unknown id never is.
    return dependsOn.every((id) => tickets.some((t) => t.id === id && t.status === 'merged'));
  }
  // Backwards compatible with waves: no lower-wave ticket may still be open (or unmerged `ready`).
  return tickets.every((t) => t.wave >= ticket.wave || SETTLED.has(t.status));
}

/**
 * The next action for the orchestrator (see docs/design/v0.2.md section 1, `next`).
 * `tickets` may be omitted; they are then loaded from state. Pure: no writes.
 * Returns { action, tickets: string[], detail: string }.
 */
export function computeNext(root, run, tickets) {
  const list = Array.isArray(tickets) ? tickets : loadTickets(root, run.id);

  if (CLOSED_PHASES.has(run.phase)) return decision('none', [], `phase ${run.phase}`);
  if (run.merging_ticket) return decision('merge-continue', [run.merging_ticket], `${run.merging_ticket} is mid-merge`);

  const blocked = list.filter((t) => t.status === 'blocked').sort(lowestFirst)[0];
  if (blocked) return decision('ask', [blocked.id], `${blocked.id} is blocked on a question`);

  if (run.phase === 'verifying') return decision('verify', [], 'phase verifying');
  if (run.phase === 'reviewing') return decision('review', [], 'phase reviewing');

  if (run.phase !== 'running') return decision('none', [], `phase ${run.phase}`);

  const running = list.filter((t) => t.status === 'running');
  const parallelism = Number.isInteger(run.parallelism) && run.parallelism > 0 ? run.parallelism : DEFAULT_PARALLELISM;
  const free = Math.max(0, parallelism - running.length);
  const launch = list.filter((t) => isLaunchable(t, list)).sort(lowestFirst).slice(0, free).map((t) => t.id);
  if (launch.length) return decision('launch', launch, `${launch.length} of ${free} slot${free === 1 ? '' : 's'} free`);

  const ready = list.filter((t) => t.status === 'ready').sort(lowestFirst)[0];
  if (ready) return decision('merge', [ready.id], `${ready.id} finished and is waiting to merge`);

  if (running.length) return decision('wait', [], `${running.length} ticket${running.length === 1 ? '' : 's'} running`);

  if (!list.some((t) => OPEN_STATUSES.includes(t.status))) {
    return decision('advance', [], 'every ticket is merged, failed or dropped');
  }
  return decision('none', [], 'no launchable ticket and nothing to merge');
}

/** The exact human line for a decision: `launch T3 T4`, `merge T2`, `verify`, `none`, ... */
export function renderActionLine({ action, tickets = [] }) {
  return tickets.length ? `${action} ${tickets.join(' ')}` : action;
}

function next(args, ctx) {
  const { root, run } = ctx.resolveRun(args);
  const result = computeNext(root, run, loadTickets(root, run.id));
  if (args.flags.json === true) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log(renderActionLine(result));
}

next.booleans = ['json'];

export default { next };
