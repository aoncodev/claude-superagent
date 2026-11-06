import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeRepo, runCli, setPhase } from './helpers.mjs';
import {
  activeRunId, charterPath, loadRun, loadTickets, saveRun, saveTicket, stateDir,
} from '../lib/state.mjs';

const sh = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};

function plan() {
  return {
    title: 'Login page',
    charter: { idea: 'Add a login page.\n\n# keep me verbatim\n', in_scope: ['login form'], out_of_scope: ['SSO'], allowed_actions: [] },
    project: { kind: 'existing', stack: null, setup: ['npm install'], checks: ['npm test', 'npm run lint'], integration_checks: [] },
    contracts: [{ id: 'C1', title: 'Auth API', path: 'docs/auth.md' }],
    tickets: [
      { id: 'T1', title: 'API', kind: 'work', wave: 1, scope: 'Build API', owns: ['src/api/'], reads: ['docs/auth.md'], contracts: ['C1'], done_when: ['tests pass', 'lint clean'] },
      { id: 'T2', title: 'UI', kind: 'work', wave: 1, scope: 'Build UI', owns: ['src/ui/'], reads: [], contracts: [], done_when: ['renders'] },
      { id: 'T3', title: 'Docs', kind: 'work', wave: 2, scope: 'Write docs', owns: ['docs/'], reads: [], contracts: [], done_when: ['docs exist'] },
    ],
  };
}

/** An approved run in a fresh repo. */
function setup() {
  const root = makeRepo();
  writeFileSync(join(root, '.gitignore'), '.env\n.env.local\n');
  writeFileSync(join(root, '.env.example'), 'EXAMPLE=1\n');
  sh(root, ['add', '.']);
  sh(root, ['commit', '-q', '-m', 'env files']);
  assert.equal(runCli(['init', '--title', 'Login'], { cwd: root }).code, 0);
  const id = activeRunId(root);
  const drafts = join(stateDir(root), 'drafts');
  mkdirSync(drafts, { recursive: true });
  writeFileSync(join(drafts, 'plan.json'), JSON.stringify(plan()));
  assert.equal(runCli(['propose', join(drafts, 'plan.json')], { cwd: root }).code, 0);
  const a = runCli(['approve'], { cwd: root });
  assert.equal(a.code, 0, a.stderr);
  return { root, id };
}

/** Stand-in for the Agent tool's worktree. */
function worktree(root, name) {
  const dir = join(root, '.claude', 'worktrees', `agent-${name}`);
  sh(root, ['worktree', 'add', '-q', '-b', `worktree-agent-${name}`, dir]);
  return dir;
}

const ticket = (root, id, t) => loadTickets(root, id).find((x) => x.id === t);

/** Claim a running ticket from a fresh worktree and commit one file under `dir`; returns the commit for a ready report. */
function workIn(root, t, name, dir = 'src/api') {
  const wt = worktree(root, name);
  const c = runCli(['claim', t], { cwd: wt });
  assert.equal(c.code, 0, c.stderr);
  mkdirSync(join(wt, dir), { recursive: true });
  writeFileSync(join(wt, dir, `${name}.js`), `${name}\n`);
  sh(wt, ['add', '-A']);
  sh(wt, ['commit', '-q', '-m', `work ${name}`]);
  return { wt, commits: [sh(wt, ['rev-parse', 'HEAD'])], branch: `worktree-agent-${name}` };
}
const start = (root, t, agent = 'a1') => runCli(['start-ticket', t, '--agent', agent], { cwd: root });

function readyReport(over = {}) {
  return {
    status: 'ready', summary: 'Done.', changed_files: ['src/api/x.js'], branch: 'worktree-agent-1',
    commits: ['abc'], checks: [{ command: 'npm test', passed: true }], handbacks: [], ...over,
  };
}

function blockedReport() {
  return readyReport({ status: 'blocked', commits: [], progress: 'Routes done; auth remains.', question: { text: 'Use JWT or sessions?', options: ['JWT', 'sessions'] } });
}

function writeJson(root, name, obj) {
  const dir = join(stateDir(root), 'drafts');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return file;
}

test('start-ticket marks the ticket running and counts the attempt', () => {
  const { root, id } = setup();
  const r = start(root, 'T1', 'agent-7');
  assert.equal(r.code, 0, r.stderr);
  const t = ticket(root, id, 'T1');
  assert.equal(t.status, 'running');
  assert.equal(t.attempts, 1);
  assert.equal(t.agent_id, 'agent-7');
  const events = readFileSync(join(stateDir(root), 'runs', id, 'events.jsonl'), 'utf8');
  assert.match(events, /"type":"ticket_started"/);
});

test('start-ticket refuses a ticket outside current_wave', () => {
  const { root, id } = setup();
  const r = start(root, 'T3');
  assert.equal(r.code, 3);
  assert.match(r.stderr, /wave/);
  assert.equal(ticket(root, id, 'T3').status, 'planned');
});

test('start-ticket refuses outside the running phase and for unknown tickets', () => {
  const { root, id } = setup();
  setPhase(root, 'merging');
  assert.equal(start(root, 'T1').code, 3);
  setPhase(root, 'running');
  assert.equal(start(root, 'T9').code, 1);
  assert.equal(runCli(['start-ticket', 'T1', '--agent'], { cwd: root }).code, 1);
  assert.equal(ticket(root, id, 'T1').attempts, 0);
});

test('start-ticket without --agent runs the ticket with no agent; set-agent records it and claim never races', () => {
  const { root, id } = setup();
  const r = runCli(['start-ticket', 'T1'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  let t = ticket(root, id, 'T1');
  assert.equal(t.status, 'running');
  assert.equal(t.attempts, 1);
  assert.equal(t.agent_id, null);
  // The worker exists only after start-ticket, so its claim always finds the ticket running.
  const wt = worktree(root, 'x1');
  assert.equal(runCli(['claim', 'T1'], { cwd: wt }).code, 0);
  const s = runCli(['set-agent', 'T1', '--agent', 'x1'], { cwd: root });
  assert.equal(s.code, 0, s.stderr);
  t = ticket(root, id, 'T1');
  assert.equal(t.agent_id, 'x1');
  assert.equal(t.attempts, 1, 'set-agent does not count an attempt');
  assert.match(readFileSync(join(stateDir(root), 'runs', id, 'events.jsonl'), 'utf8'), /"type":"agent_set"/);
});

test('start-ticket without --agent clears the agent id of the previous attempt', () => {
  const { root, id } = setup();
  assert.equal(start(root, 'T1', 'old').code, 0);
  assert.equal(runCli(['start-ticket', 'T1'], { cwd: root }).code, 0);
  assert.equal(ticket(root, id, 'T1').agent_id, null);
  assert.equal(ticket(root, id, 'T1').attempts, 2);
});

test('set-agent needs --agent and a running ticket', () => {
  const { root, id } = setup();
  assert.equal(runCli(['set-agent', 'T1', '--agent', 'a'], { cwd: root }).code, 3, 'planned ticket');
  assert.equal(start(root, 'T1').code, 0);
  assert.equal(runCli(['set-agent', 'T1'], { cwd: root }).code, 1);
  assert.equal(runCli(['set-agent', 'T9', '--agent', 'a'], { cwd: root }).code, 1);
  assert.equal(ticket(root, id, 'T1').agent_id, 'a1');
});

test('mark-failed fails a running ticket with a reason event; status shows the reason', () => {
  const { root, id } = setup();
  assert.equal(runCli(['mark-failed', 'T1', '--reason', 'x'], { cwd: root }).code, 3, 'planned ticket');
  assert.equal(start(root, 'T1').code, 0);
  assert.equal(runCli(['mark-failed', 'T1'], { cwd: root }).code, 1, 'reason required');
  const r = runCli(['mark-failed', 'T1', '--reason', 'Worker ended twice without a report.'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(ticket(root, id, 'T1').status, 'failed');
  const ev = readFileSync(join(stateDir(root), 'runs', id, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'ticket_failed');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].ticket, 'T1');
  assert.equal(ev[0].reason, 'Worker ended twice without a report.');
  const st = runCli(['status'], { cwd: root });
  assert.match(st.stdout, /- T1 failed: Worker ended twice without a report\./);
  assert.equal(runCli(['mark-failed', 'T1', '--reason', 'again'], { cwd: root }).code, 3, 'already failed');
});

test('claim from the main checkout exits 3', () => {
  const { root, id } = setup();
  assert.equal(start(root, 'T1').code, 0);
  const r = runCli(['claim', 'T1'], { cwd: root });
  assert.equal(r.code, 3);
  assert.equal(ticket(root, id, 'T1').worktree, null);
});

test('claim records worktree and branch, is idempotent, and refuses a second ticket in the same worktree', () => {
  const { root, id } = setup();
  const wt = worktree(root, 'one');
  assert.equal(runCli(['claim', 'T1'], { cwd: wt }).code, 3, 'ticket not running yet');
  start(root, 'T1');
  start(root, 'T2');
  const r = runCli(['claim', 'T1'], { cwd: wt });
  assert.equal(r.code, 0, r.stderr);
  const t = ticket(root, id, 'T1');
  assert.equal(t.worktree, wt);
  assert.equal(t.branch, 'worktree-agent-one');
  assert.equal(runCli(['claim', 'T1'], { cwd: wt }).code, 0);
  assert.equal(runCli(['claim', 'T2'], { cwd: wt }).code, 3);
  assert.equal(ticket(root, id, 'T2').worktree, null);
  // from a subdirectory the toplevel is still the worktree
  mkdirSync(join(wt, 'src'), { recursive: true });
  assert.equal(runCli(['claim', 'T1'], { cwd: join(wt, 'src') }).code, 0);
  assert.equal(ticket(root, id, 'T1').worktree, wt);
  const events = readFileSync(join(stateDir(root), 'runs', id, 'events.jsonl'), 'utf8');
  assert.match(events, /"type":"ticket_claimed"/);
});

test('claim copies an untracked .env but not a tracked .env.example and never overwrites', () => {
  const { root } = setup();
  writeFileSync(join(root, '.env'), 'SECRET=1\n');
  writeFileSync(join(root, '.env.local'), 'LOCAL=main\n');
  writeFileSync(join(root, '.env.notignored'), 'X=1\n'); // untracked but not ignored
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'sub', '.env'), 'NESTED=1\n'); // not at the top level
  const wt = worktree(root, 'env');
  writeFileSync(join(wt, '.env.local'), 'LOCAL=worker\n');
  rmSync(join(wt, '.env.example'), { force: true }); // a checked-out tracked file must not come back from main
  start(root, 'T1');
  const r = runCli(['claim', 'T1'], { cwd: wt });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(join(wt, '.env'), 'utf8'), 'SECRET=1\n');
  assert.equal(readFileSync(join(wt, '.env.local'), 'utf8'), 'LOCAL=worker\n');
  assert.equal(existsSync(join(wt, '.env.example')), false);
  assert.equal(existsSync(join(wt, '.env.notignored')), false);
  assert.equal(existsSync(join(wt, 'sub', '.env')), false);
  // a second claim does not overwrite what was copied
  writeFileSync(join(wt, '.env'), 'EDITED\n');
  assert.equal(runCli(['claim', 'T1'], { cwd: wt }).code, 0);
  assert.equal(readFileSync(join(wt, '.env'), 'utf8'), 'EDITED\n');
});


test('brief starts with the verbatim charter and includes the previous question and answer on attempt 2', () => {
  const { root, id } = setup();
  const charter = readFileSync(charterPath(root, loadRun(root, id)), 'utf8');
  start(root, 'T1');
  let b = runCli(['brief', 'T1'], { cwd: root });
  assert.equal(b.code, 0, b.stderr);
  assert.ok(b.stdout.startsWith(charter), 'charter verbatim first');
  const out = b.stdout;
  const order = ['C1', 'Auth API', 'docs/auth.md', 'Build API', 'src/api/', 'tests pass', 'npm install', 'npm run lint'].map((s) => out.indexOf(s, charter.length));
  assert.ok(order.every((i) => i >= 0), `missing section: ${order}`);
  assert.deepEqual(order, [...order].sort((a, c) => a - c));
  assert.ok(!out.includes('Use JWT or sessions?'), 'no previous report on attempt 1');
  const reportFile = join(stateDir(root), 'drafts', id, 'T1-report.json');
  assert.equal(out.trimEnd().split('\n').at(-1), `Report file: ${reportFile}`);
  assert.ok(existsSync(join(stateDir(root), 'drafts', id)));

  assert.equal(runCli(['report', 'T1', '--file', writeJson(root, 'r.json', blockedReport())], { cwd: root }).code, 0);
  assert.equal(runCli(['answer', 'T1', '--text', 'Use sessions please'], { cwd: root }).code, 0);
  assert.equal(start(root, 'T1', 'a2').code, 0);
  b = runCli(['brief', 'T1'], { cwd: root });
  assert.ok(b.stdout.startsWith(charter));
  assert.match(b.stdout, /Routes done; auth remains\./);
  assert.match(b.stdout, /Use JWT or sessions\?/);
  assert.match(b.stdout, /Use sessions please/);
  assert.equal(b.stdout.trimEnd().split('\n').at(-1), `Report file: ${reportFile}`);
});

test('brief from inside a worktree points at drafts in that worktree (the Write tool is confined to it)', () => {
  const { root, id } = setup();
  const wt = worktree(root, 'b');
  start(root, 'T1');
  const b = runCli(['brief', 'T1'], { cwd: wt });
  assert.equal(b.code, 0, b.stderr);
  const file = join(wt, '.superagent', 'drafts', id, 'T1-report.json');
  assert.equal(b.stdout.trimEnd().split('\n').at(-1), `Report file: ${file}`);
  assert.ok(existsSync(dirname(file)), 'brief creates the worktree drafts directory');
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' });
  assert.ok(!st.stdout.includes('.superagent'), `worktree .superagent/ must be git-ignored: ${st.stdout}`);
});

test('report with an invalid report exits 1 and leaves the ticket running', () => {
  const { root, id } = setup();
  start(root, 'T1');
  const bad = readyReport({ commits: [], checks: [{ command: 'npm test', passed: false }] });
  const r = runCli(['report', 'T1', '--file', writeJson(root, 'bad.json', bad)], { cwd: root });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /commits/);
  assert.match(r.stderr, /npm test/);
  assert.equal(ticket(root, id, 'T1').status, 'running');
  assert.equal(existsSync(join(stateDir(root), 'runs', id, 'reports', 'T1-1.json')), false);
  assert.equal(runCli(['report', 'T1', '--file', writeJson(root, 'junk.json', '{nope')], { cwd: root }).code, 1);
  assert.equal(runCli(['report', 'T1', '--file', join(root, 'missing.json')], { cwd: root }).code, 1);
});

test('report stores the report, sets the status and appends one handback event per handback', () => {
  const { root, id } = setup();
  start(root, 'T1');
  const { commits, branch } = workIn(root, 'T1', 'r1');
  const rep = readyReport({ commits, branch, handbacks: [{ need: 'a users table', reason: 'not owned' }, { need: 'a CI job', reason: 'outside scope' }] });
  const r = runCli(['report', 'T1', '--file', writeJson(root, 'ok.json', rep)], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'ok');
  assert.equal(ticket(root, id, 'T1').status, 'ready');
  const stored = JSON.parse(readFileSync(join(stateDir(root), 'runs', id, 'reports', 'T1-1.json'), 'utf8'));
  assert.deepEqual(stored, rep);
  const events = readFileSync(join(stateDir(root), 'runs', id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const hb = events.filter((e) => e.type === 'handback');
  assert.equal(hb.length, 2);
  assert.equal(hb[0].ticket, 'T1');
  assert.equal(hb[0].need, 'a users table');
  // a ticket that is no longer running cannot report again
  assert.equal(runCli(['report', 'T1', '--file', writeJson(root, 'ok.json', rep)], { cwd: root }).code, 3);
});

test('report blocked then answer then start-ticket increments attempts to 2', () => {
  const { root, id } = setup();
  start(root, 'T1');
  assert.equal(runCli(['report', 'T1', '--file', writeJson(root, 'b.json', blockedReport())], { cwd: root }).code, 0);
  assert.equal(ticket(root, id, 'T1').status, 'blocked');
  assert.equal(start(root, 'T1').code, 3, 'a blocked ticket must be answered first');
  const a = runCli(['answer', 'T1', '--text', 'sessions'], { cwd: root });
  assert.equal(a.code, 0, a.stderr);
  let t = ticket(root, id, 'T1');
  assert.equal(t.status, 'running');
  assert.equal(t.answer, 'sessions');
  assert.equal(start(root, 'T1', 'a2').code, 0);
  t = ticket(root, id, 'T1');
  assert.equal(t.attempts, 2);
  assert.equal(t.status, 'running');
  assert.equal(t.agent_id, 'a2');
  // the second attempt's report goes to its own file
  const { commits } = workIn(root, 'T1', 'a2');
  assert.equal(runCli(['report', 'T1', '--file', writeJson(root, 'r2.json', readyReport({ commits }))], { cwd: root }).code, 0);
  assert.ok(existsSync(join(stateDir(root), 'runs', id, 'reports', 'T1-2.json')));
  assert.ok(existsSync(join(stateDir(root), 'runs', id, 'reports', 'T1-1.json')));
});

test('answer is refused unless the ticket is blocked', () => {
  const { root } = setup();
  assert.equal(runCli(['answer', 'T1', '--text', 'x'], { cwd: root }).code, 3);
  start(root, 'T1');
  assert.equal(runCli(['answer', 'T1', '--text', 'x'], { cwd: root }).code, 3);
  assert.equal(runCli(['answer', 'T1'], { cwd: root }).code, 1);
});

test('show --json fills lastReports with the latest report per ticket', () => {
  const { root, id } = setup();
  start(root, 'T1');
  runCli(['report', 'T1', '--file', writeJson(root, 'b.json', blockedReport())], { cwd: root });
  runCli(['answer', 'T1', '--text', 'sessions'], { cwd: root });
  start(root, 'T1');
  const second = readyReport({ summary: 'Second attempt.', commits: workIn(root, 'T1', 's2').commits });
  runCli(['report', 'T1', '--file', writeJson(root, 'r.json', second)], { cwd: root });
  const out = JSON.parse(runCli(['show', '--json'], { cwd: root }).stdout);
  assert.deepEqual(Object.keys(out.lastReports), ['T1']);
  assert.equal(out.lastReports.T1.summary, 'Second attempt.');
  assert.equal(out.run.id, id);
});

function ticketJson(over = {}) {
  return {
    id: 'T4', title: 'Fix login', kind: 'fix', wave: 3, scope: 'Fix failing check', owns: ['./src/fix1/'], reads: [], contracts: ['C1'], done_when: ['check passes'], ...over,
  };
}

const addTicket = (root, t, origin) => runCli(['add-ticket', '--file', writeJson(root, 'add.json', t), '--origin', origin], { cwd: root });

test('add-ticket stores a normalized planned ticket with the given origin', () => {
  const { root, id } = setup();
  const r = addTicket(root, ticketJson({ id: 'T4', kind: 'work', wave: 2, owns: ['./src/extra/'] }), 'handback');
  assert.equal(r.code, 0, r.stderr);
  const t = ticket(root, id, 'T4');
  assert.deepEqual(
    { status: t.status, origin: t.origin, attempts: t.attempts, agent_id: t.agent_id, worktree: t.worktree, branch: t.branch, answer: t.answer, owns: t.owns },
    { status: 'planned', origin: 'handback', attempts: 0, agent_id: null, worktree: null, branch: null, answer: null, owns: ['src/extra/'] },
  );
  assert.deepEqual(loadRun(root, id).fix_waves_used, { fix: 0, fidelity: 0 });
});

test('add-ticket rejects duplicates, bad fields, overlap, bad origin and merged waves', () => {
  const { root, id } = setup();
  const bad = (t, origin = 'handback') => addTicket(root, t, origin);
  assert.equal(bad(ticketJson({ id: 'T1', kind: 'work', wave: 2 })).code, 1, 'duplicate id');
  assert.equal(bad(ticketJson({ id: 'x4' })).code, 1, 'id format');
  assert.equal(bad(ticketJson({ owns: [] })).code, 1, 'empty owns');
  assert.equal(bad(ticketJson({ owns: ['../out'] })).code, 1, 'owns outside repo');
  assert.equal(bad(ticketJson({ kind: 'bogus' })).code, 1, 'kind');
  assert.equal(bad(ticketJson({ contracts: ['C9'] })).code, 1, 'unknown contract');
  const overlap = bad(ticketJson({ kind: 'work', wave: 1, owns: ['src/api/handlers/'] }));
  assert.equal(overlap.code, 1, 'overlaps T1 in the same wave');
  assert.match(overlap.stderr, /T1/);
  assert.equal(bad(ticketJson({ kind: 'work', wave: 2 }), 'plan').code, 1, 'origin plan is not allowed');
  assert.equal(runCli(['add-ticket', '--file', writeJson(root, 'add.json', ticketJson())], { cwd: root }).code, 1, 'origin required');
  // wave must come after every merged wave
  const t1 = ticket(root, id, 'T1');
  saveTicket(root, id, { ...t1, status: 'merged' });
  assert.equal(bad(ticketJson({ kind: 'work', wave: 1, owns: ['src/other/'] })).code, 1, 'wave not after merged');
  assert.equal(bad(ticketJson({ kind: 'work', wave: 2, owns: ['src/other/'] })).code, 0);
  assert.equal(loadTickets(root, id).length, 4);
});

test('add-ticket enforces contracts-before-work against existing tickets', () => {
  const { root, id } = setup();
  const t = ticketJson({ id: 'T4', kind: 'contracts', wave: 2, owns: ['docs/api.md'], contracts: [] });
  assert.equal(addTicket(root, t, 'handback').code, 1, 'work tickets in wave 2 would not come after it');
  assert.equal(ticket(root, id, 'T4'), undefined);
});

test('add-ticket --origin fix refuses a second fix wave', () => {
  const { root, id } = setup();
  assert.equal(addTicket(root, ticketJson({ id: 'T4', wave: 3, owns: ['src/fix1/'] }), 'fix').code, 0);
  assert.equal(loadRun(root, id).fix_waves_used.fix, 1);
  // same wave again is not a new wave
  assert.equal(addTicket(root, ticketJson({ id: 'T5', wave: 3, owns: ['src/fix2/'] }), 'fix').code, 0);
  assert.equal(loadRun(root, id).fix_waves_used.fix, 1);
  const r = addTicket(root, ticketJson({ id: 'T6', wave: 4, owns: ['src/fix3/'] }), 'fix');
  assert.equal(r.code, 3);
  assert.match(r.stderr, /automatic fix wave limit reached; report to the user/);
  assert.equal(ticket(root, id, 'T6'), undefined);
  assert.deepEqual(loadRun(root, id).fix_waves_used, { fix: 1, fidelity: 0 });
  // fidelity has its own budget, handback has none
  assert.equal(addTicket(root, ticketJson({ id: 'T6', wave: 4, owns: ['src/fid/'] }), 'fidelity').code, 0);
  assert.deepEqual(loadRun(root, id).fix_waves_used, { fix: 1, fidelity: 1 });
  assert.equal(addTicket(root, ticketJson({ id: 'T7', wave: 5, kind: 'work', owns: ['src/hb/'] }), 'handback').code, 0);
  assert.equal(addTicket(root, ticketJson({ id: 'T8', wave: 6, kind: 'work', owns: ['src/hb2/'] }), 'handback').code, 0);
  assert.deepEqual(loadRun(root, id).fix_waves_used, { fix: 1, fidelity: 1 });
});

test('an invalid fix ticket does not consume the fix wave budget', () => {
  const { root, id } = setup();
  assert.equal(addTicket(root, ticketJson({ id: 'T4', wave: 3, owns: [] }), 'fix').code, 1);
  assert.equal(loadRun(root, id).fix_waves_used.fix, 0);
});

// ---- final review: CLI consistency ----

test('regression #7: set-agent records the agent of the current attempt even after the worker reported', () => {
  const { root, id } = setup();
  assert.equal(runCli(['set-agent', 'T1', '--agent', 'a'], { cwd: root }).code, 3, 'planned: no attempt yet');
  // a fast worker reports blocked before the orchestrator records its id
  assert.equal(runCli(['start-ticket', 'T1'], { cwd: root }).code, 0);
  assert.equal(runCli(['report', 'T1', '--file', writeJson(root, 'b.json', blockedReport())], { cwd: root }).code, 0);
  const r = runCli(['set-agent', 'T1', '--agent', 'fast'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(ticket(root, id, 'T1').agent_id, 'fast');
  assert.equal(ticket(root, id, 'T1').status, 'blocked');
  // and after a failed report
  assert.equal(runCli(['start-ticket', 'T2'], { cwd: root }).code, 0);
  const failed = readyReport({ status: 'failed', commits: [], progress: 'Half done.' });
  assert.equal(runCli(['report', 'T2', '--file', writeJson(root, 'T2.json', failed)], { cwd: root }).code, 0);
  assert.equal(runCli(['set-agent', 'T2', '--agent', 'late'], { cwd: root }).code, 0);
  assert.equal(ticket(root, id, 'T2').agent_id, 'late');
  saveTicket(root, id, { ...ticket(root, id, 'T2'), status: 'merged' });
  assert.equal(runCli(['set-agent', 'T2', '--agent', 'x'], { cwd: root }).code, 3, 'merged tickets are settled');
});

test('regression #10: add-ticket requires a wave after the current wave', () => {
  const { root, id } = setup();
  assert.equal(loadRun(root, id).current_wave, 1);
  const r = addTicket(root, ticketJson({ id: 'T4', kind: 'work', wave: 1, owns: ['src/late/'] }), 'handback');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /current wave/);
  assert.equal(ticket(root, id, 'T4'), undefined);
  assert.equal(addTicket(root, ticketJson({ id: 'T4', kind: 'work', wave: 2, owns: ['src/late/'] }), 'handback').code, 0);
});
