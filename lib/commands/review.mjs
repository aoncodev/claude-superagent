import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { strFlag } from '../cli.mjs';
import { RefusalError, UsageError } from '../errors.mjs';
import { renderStatus } from '../status.mjs';
import {
  activeRunId, appendEvent, loadEvents, loadLastReport, loadTickets, saveRun, stateDir, writeReview,
} from '../state.mjs';

const REVIEW_KEYS = ['unmet', 'extras', 'contradictions'];

/** Every problem with a Review as one line; [] means valid. */
function validateReview(r) {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return ['review must be a JSON object'];
  const errors = [];
  for (const key of REVIEW_KEYS) {
    if (!Array.isArray(r[key])) { errors.push(`${key} must be an array of { item, evidence }`); continue; }
    for (const [i, e] of r[key].entries()) {
      const ok = e !== null && typeof e === 'object' && !Array.isArray(e)
        && typeof e.item === 'string' && e.item.trim() !== '' && typeof e.evidence === 'string' && e.evidence.trim() !== '';
      if (!ok) errors.push(`${key}[${i}] must be { item, evidence } with non-empty strings`);
    }
  }
  return errors;
}

function verifyResult(args, ctx) {
  const passed = args.flags.passed;
  if (passed !== 'true' && passed !== 'false') throw new UsageError('usage: superagent verify-result --passed true|false [--log <file>]');
  const log = strFlag(args, 'log');
  const { root, run } = ctx.resolveRun(args);
  if (run.phase !== 'verifying') throw new RefusalError(`cannot record a verification result: run phase is ${run.phase}, expected verifying`);
  const ok = passed === 'true';
  appendEvent(root, run.id, 'verified', { passed: ok, ...(log ? { log: resolve(ctx.cwd, log) } : {}) });
  if (ok) {
    run.phase = 'reviewing';
    saveRun(root, run);
  }
  console.log(ok ? 'verification passed; phase reviewing' : 'verification failed; phase stays verifying');
}

function review(args, ctx) {
  const file = strFlag(args, 'file');
  if (!file) throw new UsageError('usage: superagent review --file <json>');
  const path = resolve(ctx.cwd, file);
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new UsageError(`cannot read review ${path}: ${e.code ?? e.message}`);
  }
  const errors = validateReview(data);
  if (errors.length) throw new UsageError(`review is invalid (${errors.length} error${errors.length === 1 ? '' : 's'}):\n${errors.map((e) => `- ${e}`).join('\n')}`);
  const { root, run } = ctx.resolveRun(args);
  if (run.phase !== 'reviewing') throw new RefusalError(`cannot record a review: run phase is ${run.phase}, expected reviewing`);
  const n = writeReview(root, run.id, { unmet: data.unmet, extras: data.extras, contradictions: data.contradictions });
  appendEvent(root, run.id, 'reviewed', {
    n, unmet: data.unmet.length, extras: data.extras.length, contradictions: data.contradictions.length,
  });
  console.log(`review ${n} recorded: ${data.unmet.length} unmet, ${data.extras.length} extras, ${data.contradictions.length} contradictions`);
}

function finish(args, ctx) {
  const { root, run } = ctx.resolveRun(args);
  if (!['verifying', 'reviewing'].includes(run.phase)) throw new RefusalError(`cannot finish: run phase is ${run.phase}, expected verifying or reviewing`);
  // Evidence must belong to the current pass: a verification after the run last entered verifying,
  // and (from reviewing) a review after the verification that moved it to reviewing.
  const events = loadEvents(root, run.id);
  const lastIndex = (pred) => { for (let i = events.length - 1; i >= 0; i--) if (pred(events[i])) return i; return -1; };
  const enteredVerifying = lastIndex((e) => e.type === 'phase' && e.to === 'verifying');
  const verifiedAt = lastIndex((e) => e.type === 'verified');
  if (verifiedAt <= enteredVerifying) {
    throw new RefusalError('cannot finish: no verification recorded for this pass; run the checks and `superagent verify-result --passed true|false` first');
  }
  let reviewedAt = -1;
  if (run.phase === 'reviewing') {
    const passedAt = lastIndex((e) => e.type === 'verified' && e.passed === true);
    reviewedAt = lastIndex((e) => e.type === 'reviewed');
    if (reviewedAt <= passedAt) {
      throw new RefusalError('cannot finish: no fidelity review recorded since verification passed; record one with `superagent review --file <json>` first');
    }
  }
  const from = run.phase;
  run.phase = 'done';
  saveRun(root, run);
  appendEvent(root, run.id, 'finished', { from });
  if (activeRunId(root) === run.id) rmSync(join(stateDir(root), 'active'), { force: true });
  const v = events[verifiedAt];
  console.log(`finished ${run.id}`);
  console.log(`verification: ${v.passed ? 'passed' : 'failed'}${v.log ? ` (log ${v.log})` : ''}`);
  const r = reviewedAt >= 0 ? events[reviewedAt] : null;
  console.log(r ? `review ${r.n}: ${r.unmet} unmet, ${r.extras} extras, ${r.contradictions} contradictions` : 'review: none');
}

function status(args, ctx) {
  const { root, run } = ctx.resolveRun(args);
  const tickets = loadTickets(root, run.id);
  const lastReports = {};
  for (const t of tickets) {
    const r = loadLastReport(root, run.id, t.id);
    if (r) lastReports[t.id] = r;
  }
  const events = loadEvents(root, run.id);
  const text = renderStatus(run, tickets, lastReports, events);
  if (args.flags.json === true) console.log(JSON.stringify({ text, run, tickets, lastReports }, null, 2));
  else console.log(text);
}
status.booleans = ['json'];

export default { 'verify-result': verifyResult, review, finish, status };
