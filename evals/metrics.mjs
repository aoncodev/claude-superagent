// Eval metrics for one superagent run: the `superagent stats` JSON shape plus
// `human_interventions`, the count of events that needed a person (approvals and answers).
// Read-only; derived from run.json, the tickets and events.jsonl.
import { loadEvents, loadRun, loadTickets } from '../lib/state.mjs';

const count = (values) => {
  const out = {};
  for (const v of values.sort()) out[v] = (out[v] ?? 0) + 1;
  return out;
};

function finishedAt(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if ((e.type === 'finished' || e.type === 'aborted') && typeof e.ts === 'string') {
      const t = Date.parse(e.ts);
      if (!Number.isNaN(t)) return t;
    }
  }
  return null;
}

const isHuman = (e) => e.type === 'approved' || e.type === 'answered';

/** Stats for one run, plus human_interventions. Throws StateError like loadRun/loadEvents. */
export function metricsForRun(root, runId) {
  const run = loadRun(root, runId);
  const tickets = loadTickets(root, runId);
  const events = loadEvents(root, runId);

  const created = Date.parse(run.created_at);
  const finished = ['done', 'aborted'].includes(run.phase) ? finishedAt(events) : null;
  const end = finished ?? Date.now();

  return {
    id: run.id,
    title: run.title,
    phase: run.phase,
    wave: run.current_wave ?? null,
    parallelism: run.parallelism ?? null,
    created_at: run.created_at ?? null,
    finished_at: finished === null ? null : new Date(finished).toISOString(),
    duration_seconds: Number.isNaN(created) ? null : Math.max(0, Math.round((end - created) / 1000)),
    tickets_total: tickets.length,
    tickets_by_status: count(tickets.map((t) => t.status)),
    tickets_by_origin: count(tickets.map((t) => t.origin ?? 'plan')),
    attempts: tickets.reduce((n, t) => n + (t.attempts ?? 0), 0),
    blocked_events: events.filter((e) => e.type === 'ticket_reported' && e.status === 'blocked').length,
    merge_conflicts: events.filter((e) => e.type === 'merge_conflict').length,
    merges: events.filter((e) => e.type === 'merged').length,
    verifications: events.filter((e) => e.type === 'verified').length,
    reviews: events.filter((e) => e.type === 'reviewed').length,
    fix_waves_used: run.fix_waves_used ?? { fix: 0, fidelity: 0 },
    events_total: events.length,
    human_interventions: events.filter(isHuman).length,
  };
}
