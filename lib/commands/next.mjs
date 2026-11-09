// v0.2 orchestrator scheduler: `next` says the single next action for the orchestrator.
// Read-only: it never writes run or ticket state.
import { loadTickets } from '../state.mjs';
import { overlaps } from '../plan.mjs';

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
  // A frontier launch may run beside a lower-wave ticket that is still in flight. Two workers must
  // never own the same paths (the plan validation rejects it, but an added or retargeted ticket could
  // slip through), so refuse while any running or ready ticket overlaps this one.
  const inFlight = tickets.filter((t) => t.id !== ticket.id && (t.status === 'running' || t.status === 'ready'));
  if (inFlight.some((t) => overlaps(t.owns ?? [], ticket.owns ?? []).length)) return false;
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
  // Two tickets selected in the same action must not overlap either (defensive; plan validation
  // rejects it, but add-ticket/retarget could otherwise slip a pair through).
  const selected = [];
  for (const candidate of list.filter((t) => isLaunchable(t, list)).sort(lowestFirst)) {
    if (selected.length >= free) break;
    if (selected.some((s) => overlaps(s.owns ?? [], candidate.owns ?? []).length)) continue;
    selected.push(candidate);
  }
  if (selected.length) {
    const launch = selected.map((t) => t.id);
    return decision('launch', launch, `${launch.length} of ${free} slot${free === 1 ? '' : 's'} free`);
  }

  const ready = list.filter((t) => t.status === 'ready').sort(lowestFirst)[0];
  if (ready) return decision('merge', [ready.id], `${ready.id} finished and is waiting to merge`);

  if (running.length) return decision('wait', [], `${running.length} ticket${running.length === 1 ? '' : 's'} running`);

  // A planned ticket whose explicit dependency failed or was dropped can never launch; report it so
  // the orchestrator can retarget it at the handback/fix ticket or drop it.
  const stuck = list
    .filter((t) => t.status === 'planned' && (t.depends_on ?? []).some((id) => {
      const dep = list.find((d) => d.id === id);
      return dep && (dep.status === 'failed' || dep.status === 'dropped');
    }))
    .sort(lowestFirst)
    .map((t) => t.id);
  if (stuck.length) return decision('stuck', stuck, 'a dependency failed or was dropped');

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
