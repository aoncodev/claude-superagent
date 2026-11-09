// v0.2 orchestrator metadata commands: ruling, context. Owned by the state/ticket workstream.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { strFlag } from '../cli.mjs';
import { UsageError } from '../errors.mjs';
import { appendEvent, loadLastReport, loadTickets, stateDir } from '../state.mjs';
import { computeNext, renderActionLine } from './next.mjs';

/** Record an orchestrator decision in the run's event log. */
function ruling(args, ctx) {
  const text = strFlag(args, 'text');
  if (!text || !text.trim()) throw new UsageError('usage: superagent ruling --text <text> [--ticket <ticket-id>]');
  const ticket = strFlag(args, 'ticket');
  const { root, run } = ctx.resolveRun(args);
  appendEvent(root, run.id, 'ruling', ticket === undefined ? { text } : { text, ticket });
  console.log('ruling recorded');
}

/** The latest review stored for the run, or null. */
function latestReview(root, run) {
  const dir = join(stateDir(root), 'runs', run.id, 'reviews');
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  let n = 0;
  for (const f of names) {
    const m = /^(\d+)\.json$/.exec(f);
    if (m) n = Math.max(n, Number(m[1]));
  }
  if (!n) return null;
  try {
    return JSON.parse(readFileSync(join(dir, `${n}.json`), 'utf8'));
  } catch {
    return null;
  }
}

const ticketNum = (t) => Number(String(t.id).slice(1));

/** Compact, read-only resume brief for the orchestrator after compaction (see docs/design/v0.2.md). */
function context(args, ctx) {
  const { root, run } = ctx.resolveRun(args);
  const tickets = loadTickets(root, run.id);
  const count = (status) => tickets.filter((t) => t.status === status).length;
  const lines = [
    `run: ${run.id} · ${run.title}`,
    `phase: ${run.phase} · wave: ${run.current_wave ?? '-'} · parallelism: ${run.parallelism}`,
    `branch: ${run.integration_branch ?? '-'} (base ${run.base_branch ?? '-'})`,
    `tickets: ${tickets.length} (${['merged', 'running', 'planned', 'blocked', 'failed', 'dropped'].map((s) => `${count(s)} ${s}`).join(', ')})`,
  ];
  for (const t of tickets) {
    if (t.status === 'merged' || t.status === 'dropped') continue;
    lines.push(`${t.id} ${t.status} wave ${t.wave} · ${t.title}`);
  }
  const blocked = tickets.filter((t) => t.status === 'blocked').sort((a, b) => ticketNum(a) - ticketNum(b));
  for (const t of blocked) {
    const question = loadLastReport(root, run.id, t.id)?.question?.text ?? '(no question recorded)';
    lines.push(`blocked: ${t.id}: ${question}`);
  }
  const review = latestReview(root, run);
  lines.push(`fidelity: ${review
    ? `${review.unmet?.length ?? 0} unmet, ${review.extras?.length ?? 0} extras, ${review.contradictions?.length ?? 0} contradictions`
    : 'none'}`);
  lines.push(`next: ${renderActionLine(computeNext(root, run, tickets))}`);
  console.log(lines.join('\n'));
}

export default { ruling, context };
