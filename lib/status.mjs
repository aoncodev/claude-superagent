// Plain-text status of a run: what needs the user, then one progress line.

/** First sentence of a text, whitespace collapsed. */
function firstSentence(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const m = /^.*?[.!?](?=\s|$)/.exec(s);
  return m ? m[0] : s;
}

/**
 * @param {object} run
 * @param {object[]} tickets
 * @param {Record<string, object>} lastReports last report per ticket id
 * @param {object[]} events run events (accepted for callers that have them; the text does not depend on them)
 */
export function renderStatus(run, tickets, lastReports = {}, events = []) { // eslint-disable-line no-unused-vars
  const needs = [];
  if (run.phase === 'awaiting_approval') needs.push('approve the split');
  for (const t of tickets) {
    const report = lastReports[t.id];
    if (t.status === 'blocked') {
      needs.push(`${t.id} asks: ${report?.question?.text ?? '(no question recorded)'}`);
    } else if (t.status === 'failed' || t.status === 'dropped') {
      const summary = report?.summary ? firstSentence(report.summary) : '';
      needs.push(`${t.id} ${t.status}: ${summary || 'no report'}`);
    }
  }
  if (run.phase === 'merging' && run.merging_ticket) {
    needs.push(`${run.merging_ticket} has a merge conflict: resolve it, stage the files, then run \`superagent merge-continue\``);
  }

  const count = (status) => tickets.filter((t) => t.status === status).length;
  const max = tickets.length ? Math.max(...tickets.map((t) => t.wave)) : '-';
  const progress = `Run ${run.id} · ${run.phase} · wave ${run.current_wave ?? '-'}/${max} · ${count('running')} running · ${count('merged')} merged · ${count('planned')} planned`;

  const lines = needs.length ? ['Needs you:', ...needs.map((n) => `- ${n}`)] : ['Nothing needs you.'];
  lines.push(progress);
  return lines.join('\n');
}
