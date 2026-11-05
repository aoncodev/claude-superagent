// Worker report validation. A Report is what a worker hands back through `superagent report`.

export const REPORT_STATUSES = ['ready', 'blocked', 'failed', 'dropped'];
export const MAX_SUMMARY_WORDS = 100;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/** Whitespace-separated tokens; every CJK character counts as one word on its own. */
export function wordCount(text) {
  const s = String(text ?? '');
  const cjk = s.match(CJK)?.length ?? 0;
  const rest = s.replace(CJK, ' ').split(/\s+/).filter(Boolean).length;
  return cjk + rest;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const strArray = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');

/** Validate a worker report. Returns every problem as one line; [] means valid. */
export function validateReport(r) {
  if (!isObj(r)) return ['report must be a JSON object'];
  const errors = [];

  if (!REPORT_STATUSES.includes(r.status)) {
    errors.push(`status must be one of ${REPORT_STATUSES.join(', ')} (got ${JSON.stringify(r.status)})`);
  }

  if (!nonEmpty(r.summary)) errors.push('summary must be a non-empty string');
  else if (wordCount(r.summary) > MAX_SUMMARY_WORDS) {
    errors.push(`summary is ${wordCount(r.summary)} words; the limit is ${MAX_SUMMARY_WORDS}`);
  }

  const hasQuestion = r.question !== undefined && r.question !== null;
  if (r.status === 'blocked' && !hasQuestion) errors.push('a blocked report must carry exactly one question');
  if (r.status !== 'blocked' && hasQuestion) errors.push(`question is only allowed when status is blocked (status is ${JSON.stringify(r.status)})`);
  if (hasQuestion) {
    if (!isObj(r.question)) errors.push('question must be an object { text, options? }');
    else {
      if (!nonEmpty(r.question.text)) errors.push('question.text must be a non-empty string');
      if (r.question.options !== undefined && !strArray(r.question.options)) errors.push('question.options must be an array of strings');
    }
  }

  if ((r.status === 'blocked' || r.status === 'failed') && !nonEmpty(r.progress)) {
    errors.push(`progress is required when status is ${r.status}: say what is done and what remains`);
  }
  if (r.progress !== undefined && typeof r.progress !== 'string') errors.push('progress must be a string');

  if (r.branch !== undefined && typeof r.branch !== 'string') errors.push('branch must be a string');
  for (const key of ['changed_files', 'commits']) {
    if (r[key] !== undefined && !strArray(r[key])) errors.push(`${key} must be an array of strings`);
  }
  if (r.handbacks !== undefined) {
    if (!Array.isArray(r.handbacks)) errors.push('handbacks must be an array of { need, reason }');
    else {
      for (const [i, h] of r.handbacks.entries()) {
        if (!isObj(h) || !nonEmpty(h.need) || !nonEmpty(h.reason)) errors.push(`handbacks[${i}] must be { need, reason } with non-empty strings`);
      }
    }
  }

  let checksOk = false;
  if (!Array.isArray(r.checks)) errors.push('checks must be an array of { command, passed }');
  else {
    checksOk = true;
    for (const [i, c] of r.checks.entries()) {
      if (!isObj(c) || typeof c.command !== 'string' || typeof c.passed !== 'boolean') {
        errors.push(`checks[${i}] must be { command: string, passed: boolean }`);
        checksOk = false;
      }
    }
  }

  if (r.status === 'ready') {
    if (!Array.isArray(r.commits) || r.commits.length === 0) errors.push('a ready report must list at least one commit in commits');
    if (checksOk) {
      for (const c of r.checks) if (!c.passed) errors.push(`a ready report cannot have a failing check: ${c.command}`);
    }
  }
  return errors;
}
