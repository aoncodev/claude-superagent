// Plain-text status of a run: what needs the user, then one progress line.

/** First sentence of a text, whitespace collapsed. */
function firstSentence(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const m = /^.*?[.!?](?=\s|$)/.exec(s);
  return m ? m[0] : s;
}

/** The reason of the ticket's latest `ticket_failed` event, if that is newer than its latest report. */
function markedFailedReason(events, id) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.ticket !== id) continue;
    if (e.type === 'ticket_failed') return e.reason ?? null;
    if (e.type === 'ticket_reported') return null;
  }
  return null;
}

/**
 * @param {object} run
 * @param {object[]} tickets
 * @param {Record<string, object>} lastReports last report per ticket id
 * @param {object[]} events run events, oldest first (used for `mark-failed` reasons)
 */
export function renderStatus(run, tickets, lastReports = {}, events = []) {
  const needs = [];
  if (run.phase === 'awaiting_approval') needs.push('approve the split');
  for (const t of tickets.filter((x) => x.status === 'blocked')) {
    needs.push(`${t.id} asks: ${lastReports[t.id]?.question?.text ?? '(no question recorded)'}`);
  }
  // Failed and dropped tickets need the user while their wave is open; the orchestrator settles them
  // (handbacks, fix tickets, or the final report) before the run moves on.
  const waveOpen = run.phase === 'running' || run.phase === 'merging';
  for (const t of tickets.filter((x) => waveOpen && (x.status === 'failed' || x.status === 'dropped'))) {
    const marked = t.status === 'failed' ? markedFailedReason(events, t.id) : null;
    const summary = marked ?? (lastReports[t.id]?.summary ? firstSentence(lastReports[t.id].summary) : '');
    needs.push(`${t.id} ${t.status}: ${summary || 'no report'}`);
  }
  if (run.phase === 'merging' && run.merging_ticket) {
    needs.push(`${run.merging_ticket} has a merge conflict: resolve it, stage the files, then run \`superagent merge-continue\` (or \`superagent merge-abort ${run.merging_ticket}\` to drop it)`);
  }

  const count = (status) => tickets.filter((t) => t.status === status).length;
  const max = tickets.length ? Math.max(...tickets.map((t) => t.wave)) : '-';
  const progress = `Run ${run.id} · ${run.phase} · wave ${run.current_wave ?? '-'}/${max} · ${count('running')} running · ${count('merged')} merged · ${count('planned')} planned`;

  const lines = needs.length ? ['Needs you:', ...needs.map((n) => `- ${n}`)] : ['Nothing needs you.'];
  lines.push(progress);
  return lines.join('\n');
}
