import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { strFlag } from '../cli.mjs';
import { RefusalError, StateError, UsageError } from '../errors.mjs';
import { git } from '../git.mjs';
import { parseCharter } from '../plan.mjs';
import { renderStatus } from '../status.mjs';
import {
  activeRunId, appendEvent, loadEvents, loadLastReport, loadTickets, readCharter, saveRun, stateDir, writeReview,
} from '../state.mjs';

const REVIEW_KEYS = ['met', 'unmet', 'extras', 'contradictions'];

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

// Coverage compares meaning, not formatting: case, whitespace and trailing sentence punctuation do
// not decide whether the reviewer assessed an item. The skill asks for the Charter's own words.
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.,;:!?]+$/g, '').trim();

/**
 * Coverage check: every in-scope Charter item must be assessed exactly once, in `met` or `unmet`.
 * The reviewer is told to use the Charter's own words, so matching is exact after whitespace
 * normalization. Extra entries are allowed (they are not coverage evidence either way).
 */
export function coverageErrors(inScope, review) {
  const errors = [];
  const items = (inScope ?? []).map((raw) => ({ raw: String(raw), key: norm(raw) })).filter((i) => i.key !== '');
  const met = (review.met ?? []).map((e) => norm(e.item));
  const unmet = (review.unmet ?? []).map((e) => norm(e.item));
  for (const { raw, key } of items) {
    const inMet = met.includes(key);
    const inUnmet = unmet.includes(key);
    if (inMet && inUnmet) errors.push(`review lists in-scope Charter item ${JSON.stringify(raw)} in both met and unmet`);
    else if (!inMet && !inUnmet) errors.push(`review does not assess in-scope Charter item ${JSON.stringify(raw)}: put it in met or unmet`);
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
  const charter = parseCharter(readCharter(root, run));
  if (!charter) throw new StateError(`cannot parse the Charter of ${run.id}; cannot check review coverage`);
  const coverage = coverageErrors(charter.in_scope, data);
  if (coverage.length) throw new UsageError(`review is invalid (${coverage.length} coverage error${coverage.length === 1 ? '' : 's'}):\n${coverage.map((e) => `- ${e}`).join('\n')}`);
  const n = writeReview(root, run.id, {
    met: data.met, unmet: data.unmet, extras: data.extras, contradictions: data.contradictions,
  });
  appendEvent(root, run.id, 'reviewed', {
    n, met: data.met.length, unmet: data.unmet.length, extras: data.extras.length, contradictions: data.contradictions.length,
  });
  console.log(`review ${n} recorded: ${data.met.length} met, ${data.unmet.length} unmet, ${data.extras.length} extras, ${data.contradictions.length} contradictions`);
}

/**
 * Give the fidelity reviewer a checkout with no run state: a detached worktree of the integration
 * branch at a fresh temp path (untracked `.superagent/` is never copied into a worktree). The path is
 * printed alone; idempotent while the stored worktree still exists.
 */
function reviewSetup(args, ctx) {
  const { root, run } = ctx.resolveRun(args);
  if (run.phase !== 'reviewing') throw new RefusalError(`cannot set up a review worktree: run phase is ${run.phase}, expected reviewing`);
  if (typeof run.review_worktree === 'string' && run.review_worktree !== '' && existsSync(run.review_worktree)) {
    console.log(run.review_worktree);
    return;
  }
  if (typeof run.integration_branch !== 'string' || run.integration_branch === '') {
    throw new RefusalError('cannot set up a review worktree: the run has no integration branch');
  }
  // git worktree add needs a path that does not exist yet.
  const path = join(tmpdir(), `superagent-review-${run.id}-${randomBytes(4).toString('hex')}`);
  git(['worktree', 'add', '--detach', path, run.integration_branch], root);
  run.review_worktree = path;
  saveRun(root, run);
  appendEvent(root, run.id, 'review_worktree_created', { path });
  console.log(path);
}

function reviewClose(args, ctx) {
  const { root, run } = ctx.resolveRun(args);
  const path = run.review_worktree;
  if (typeof path === 'string' && path !== '') {
    try {
      git(['worktree', 'remove', '--force', path], root);
    } catch (e) {
      // A path the OS already cleared (e.g. tmp was emptied) is still "removed"; anything else is real.
      if (existsSync(path)) throw e;
    }
  }
  run.review_worktree = null;
  saveRun(root, run);
  appendEvent(root, run.id, 'review_worktree_removed', typeof path === 'string' && path !== '' ? { path } : {});
  console.log('review worktree removed');
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

export default { 'verify-result': verifyResult, review, 'review-setup': reviewSetup, 'review-close': reviewClose, finish, status };
