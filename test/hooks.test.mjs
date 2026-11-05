import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo, runHook } from './helpers.mjs';

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = join(PLUGIN, 'hooks', 'guard-files.mjs');
const BASH = join(PLUGIN, 'hooks', 'guard-bash.mjs');

function sh(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A repo with an active run in `phase`, and a worker worktree inside it claimed by T1 (owns apps/web/). */
function setup(phase = 'running', runExtra = {}) {
  const root = makeRepo();
  const wt = join(root, '.claude', 'worktrees', 'agent-a1');
  sh(root, ['worktree', 'add', '-q', '-b', 'worker/t1', wt]);
  const runDir = join(root, '.superagent', 'runs', 'r1');
  mkdirSync(join(runDir, 'tickets'), { recursive: true });
  writeFileSync(join(root, '.superagent', 'active'), 'r1\n');
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ id: 'r1', title: 't', phase, allowed_actions: [], ...runExtra }));
  writeFileSync(join(runDir, 'tickets', 'T1.json'), JSON.stringify({ id: 'T1', wave: 1, owns: ['apps/web/'], status: 'running', worktree: wt, branch: 'worker/t1' }));
  return { root, wt, runDir };
}

const payload = (cwd, tool_name, tool_input, extra = {}) => ({ cwd, tool_name, tool_input, hook_event_name: 'PreToolUse', ...extra });
const denyReason = (r) => {
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
};
const allowed = (r) => { assert.equal(r.code, 0); assert.equal(r.stdout, ''); };

test('guard-files denies an out-of-scope write with the deny JSON', () => {
  const { wt } = setup();
  const r = runHook(FILES, payload(wt, 'Write', { file_path: join(wt, 'apps/api/x.ts'), content: 'x' }, { agent_type: 'superagent:worker', agent_id: 'a1' }));
  assert.match(denyReason(r), /Out-of-scope needs go in your report's handbacks\./);
  assert.equal(r.stderr, '');
});

test('guard-files allows an in-scope write, and handles relative paths against cwd', () => {
  const { wt } = setup();
  allowed(runHook(FILES, payload(wt, 'Write', { file_path: join(wt, 'apps/web/a.ts'), content: 'x' })));
  allowed(runHook(FILES, payload(wt, 'Edit', { file_path: 'apps/web/a.ts', old_string: 'a', new_string: 'b' })));
  denyReason(runHook(FILES, payload(wt, 'Edit', { file_path: 'apps/api/a.ts', old_string: 'a', new_string: 'b' })));
  denyReason(runHook(FILES, payload(wt, 'MultiEdit', { file_path: 'apps/web/../api/a.ts', edits: [] })));
  mkdirSync(join(wt, 'apps/web'), { recursive: true });
  denyReason(runHook(FILES, payload(join(wt, 'apps/web'), 'Write', { file_path: '../api/a.ts', content: '' })));
  denyReason(runHook(FILES, payload(wt, 'NotebookEdit', { notebook_path: 'docs/n.ipynb', new_source: '' })));
  allowed(runHook(FILES, payload(wt, 'NotebookEdit', { notebook_path: 'apps/web/n.ipynb', new_source: '' })));
});

test('guard-files: path inside a worker worktree is never judged as the main checkout', () => {
  const { root, wt } = setup('running');
  // Orchestrator cwd = main; writing into the worker's owned dir passes, main source does not.
  allowed(runHook(FILES, payload(root, 'Write', { file_path: join(wt, 'apps/web/a.ts'), content: '' })));
  assert.match(denyReason(runHook(FILES, payload(root, 'Write', { file_path: join(root, 'src/a.ts'), content: '' }))), /read-only while a wave runs/);
});

test('guard-files: symlink escape from the worktree is denied', () => {
  const { wt, root } = setup();
  mkdirSync(join(wt, 'apps/web'), { recursive: true });
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'superagent-out-')));
  symlinkSync(outside, join(wt, 'apps/web/escape'));
  denyReason(runHook(FILES, payload(wt, 'Write', { file_path: join(wt, 'apps/web/escape/x.ts'), content: '' })));
  symlinkSync(join(root, 'src'), join(wt, 'apps/web/tomain'));
  denyReason(runHook(FILES, payload(wt, 'Write', { file_path: join(wt, 'apps/web/tomain/x.ts'), content: '' })));
});

test('guard-files: drafts writable, runs/ denied, in every phase', () => {
  for (const phase of ['proposing', 'running', 'merging', 'done']) {
    const { root } = setup(phase);
    allowed(runHook(FILES, payload(root, 'Write', { file_path: join(root, '.superagent/drafts/r1/plan.json'), content: '' })));
    assert.match(denyReason(runHook(FILES, payload(root, 'Write', { file_path: join(root, '.superagent/runs/r1/charter.r1.md'), content: '' }))), /superagent CLI/);
  }
});

test('guard-files: a claim-less worktree gets the claim hint', () => {
  const { root } = setup();
  const wt2 = join(root, '.claude', 'worktrees', 'agent-b2');
  sh(root, ['worktree', 'add', '-q', '-b', 'worker/t2', wt2]);
  assert.match(denyReason(runHook(FILES, payload(wt2, 'Write', { file_path: join(wt2, 'a.ts'), content: '' }))), /superagent claim <ticket>/);
});

test('guard-files: no run, or unrelated phase, allows silently', () => {
  const { root } = setup('proposing');
  allowed(runHook(FILES, payload(root, 'Write', { file_path: join(root, 'src/a.ts'), content: '' })));
  const bare = makeRepo();
  allowed(runHook(FILES, payload(bare, 'Write', { file_path: join(bare, 'a.ts'), content: '' })));
  // .superagent/ exists but is inactive: only rule 1 can fire.
  mkdirSync(join(bare, '.superagent'));
  allowed(runHook(FILES, payload(bare, 'Write', { file_path: join(bare, 'a.ts'), content: '' })));
  denyReason(runHook(FILES, payload(bare, 'Write', { file_path: join(bare, '.superagent/runs/x/run.json'), content: '' })));
});

test('guard-bash denies git push during a running phase', () => {
  const { root } = setup();
  assert.match(denyReason(runHook(BASH, payload(root, 'Bash', { command: 'cd app && git push origin main' }))), /Blocked: `push`/);
  allowed(runHook(BASH, payload(root, 'Bash', { command: 'git status' })));
});

test('guard-bash honours the frozen allowed_actions and config production markers', () => {
  const { root } = setup('running', { allowed_actions: ['push'] });
  allowed(runHook(BASH, payload(root, 'Bash', { command: 'git push' })));
  writeFileSync(join(root, '.superagent', 'config.json'), JSON.stringify({ production_markers: ['prod.example.com'] }));
  assert.match(denyReason(runHook(BASH, payload(root, 'Bash', { command: 'curl https://prod.example.com/x' }))), /`production`/);
});

test('guard-bash denies run-state writes whenever .superagent/ exists', () => {
  const { root } = setup('proposing');
  assert.match(denyReason(runHook(BASH, payload(root, 'Bash', { command: 'echo x > .superagent/runs/r1/charter.r1.md' }))), /superagent CLI/);
  allowed(runHook(BASH, payload(root, 'Bash', { command: 'git push' })));
});

test('a corrupt run.json makes both hooks exit 0 with a stderr warning', () => {
  const { root, runDir } = setup();
  writeFileSync(join(runDir, 'run.json'), '{ not json');
  const f = runHook(FILES, payload(root, 'Write', { file_path: join(root, 'src/a.ts'), content: '' }));
  assert.equal(f.code, 0); assert.equal(f.stdout, '');
  assert.match(f.stderr, /^superagent guard: .+ \(allowing\)\n$/);
  const b = runHook(BASH, payload(root, 'Bash', { command: 'git push' }));
  assert.equal(b.code, 0); assert.equal(b.stdout, '');
  assert.match(b.stderr, /^superagent guard: .+ \(allowing\)\n$/);
});

test('corrupt state still cannot be used to rewrite the runs directory', () => {
  const { root, runDir } = setup();
  writeFileSync(join(runDir, 'run.json'), '{ not json');
  denyReason(runHook(FILES, payload(root, 'Write', { file_path: join(runDir, 'run.json'), content: '{}' })));
  denyReason(runHook(BASH, payload(root, 'Bash', { command: `echo '{}' > ${join(runDir, 'run.json')}` })));
});

test('a corrupt ticket, an unreadable active pointer, or a corrupt config fail open with a warning', () => {
  const a = setup();
  writeFileSync(join(a.runDir, 'tickets', 'T1.json'), 'garbage');
  const f = runHook(FILES, payload(a.wt, 'Write', { file_path: join(a.wt, 'apps/api/x.ts'), content: '' }));
  assert.equal(f.code, 0); assert.equal(f.stdout, ''); assert.match(f.stderr, /superagent guard: .+ \(allowing\)/);

  const b = setup();
  writeFileSync(join(b.root, '.superagent', 'active'), 'no-such-run\n');
  const g = runHook(BASH, payload(b.root, 'Bash', { command: 'git push' }));
  assert.equal(g.code, 0); assert.equal(g.stdout, ''); assert.match(g.stderr, /superagent guard: .+ \(allowing\)/);

  const c = setup();
  writeFileSync(join(c.root, '.superagent', 'config.json'), '][');
  const h = runHook(BASH, payload(c.root, 'Bash', { command: 'git push' }));
  denyReason(h); // an unreadable config does not disable push blocking (see fix 2)
  assert.match(h.stderr, /superagent guard: .+/);
});

test('malformed stdin fails open with a warning', () => {
  for (const script of [FILES, BASH]) {
    const r = spawnSync('node', [script], { input: 'not json', encoding: 'utf8' });
    assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.match(r.stderr, /^superagent guard: .+ \(allowing\)\n$/);
  }
});

test('a non-repo cwd exits 0 with no output', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'superagent-norepo-')));
  for (const [script, tool, input] of [[FILES, 'Write', { file_path: join(dir, 'a.ts'), content: '' }], [BASH, 'Bash', { command: 'git push' }]]) {
    const r = runHook(script, payload(dir, tool, input));
    assert.equal(r.code, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
  }
});

test('hooks.json registers both guards with ${CLAUDE_PLUGIN_ROOT} and a 10s timeout', () => {
  const cfg = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  const entries = cfg.hooks.PreToolUse;
  assert.equal(entries.length, 2);
  const byMatcher = Object.fromEntries(entries.map((e) => [e.matcher, e.hooks[0]]));
  assert.equal(byMatcher['Write|Edit|MultiEdit|NotebookEdit'].command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/guard-files.mjs"');
  assert.equal(byMatcher.Bash.command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/guard-bash.mjs"');
  for (const h of Object.values(byMatcher)) { assert.equal(h.type, 'command'); assert.equal(h.timeout, 10); }
  assert.ok(existsSync(FILES) && existsSync(BASH));
});

// ---- fix round 1 ----

test('fix 2: an unreadable config.json does not disable push blocking; it warns', () => {
  const { root } = setup();
  writeFileSync(join(root, '.superagent', 'config.json'), '][');
  const r = runHook(BASH, payload(root, 'Bash', { command: 'git push' }));
  assert.match(denyReason(r), /Blocked: `push`/);
  assert.match(r.stderr, /^superagent guard: config\.json unreadable: .+ \(continuing with defaults\)\n$/);
  const ok = runHook(BASH, payload(root, 'Bash', { command: 'git status' }));
  assert.equal(ok.code, 0); assert.equal(ok.stdout, ''); assert.match(ok.stderr, /superagent guard: config\.json unreadable/);
});

test('fix 2: an unloadable run still fails open', () => {
  const { root } = setup();
  writeFileSync(join(root, '.superagent', 'active'), 'no-such-run\n');
  const r = runHook(BASH, payload(root, 'Bash', { command: 'git push' }));
  assert.equal(r.code, 0); assert.equal(r.stdout, ''); assert.match(r.stderr, /superagent guard: .+ \(allowing\)/);
});

test('fix 1/6: parent-dir tampering and git clean -x are denied by the hook', () => {
  const { root } = setup();
  for (const command of ['rm -rf .superagent', 'mv .superagent /tmp/x', 'git clean -fdx', 'cd .superagent && echo x > runs/r1/run.json', 'git \\\npush']) {
    denyReason(runHook(BASH, payload(root, 'Bash', { command })));
  }
});

test('fix 7: from one worktree, writing into another worktree is denied', () => {
  const { root, wt } = setup();
  const wt2 = join(root, '.claude', 'worktrees', 'agent-b2');
  sh(root, ['worktree', 'add', '-q', '-b', 'worker/t2', wt2]);
  writeFileSync(join(root, '.superagent/runs/r1/tickets/T2.json'), JSON.stringify({ id: 'T2', wave: 1, owns: ['apps/api/'], status: 'running', worktree: wt2, branch: 'worker/t2' }));
  const target = join(wt2, 'apps/api/a.ts');
  assert.match(denyReason(runHook(FILES, payload(wt, 'Write', { file_path: target, content: '' }))), /You may only edit inside your own worktree\./);
  allowed(runHook(FILES, payload(wt2, 'Write', { file_path: target, content: '' })));
  allowed(runHook(FILES, payload(root, 'Write', { file_path: target, content: '' })));
});

test('e2e fix: a worker may write its report under its own worktree .superagent/drafts/, not runs/ or another worktree', () => {
  // E2E finding: Claude Code confines a worktree-isolated agent's Write tool to its worktree, so the
  // report file must live in the worktree (git-ignored via the shared info/exclude).
  const { root, wt } = setup();
  const w = { agent_type: 'superagent:worker', agent_id: 'a1' };
  allowed(runHook(FILES, payload(wt, 'Write', { file_path: join(wt, '.superagent/drafts/r1/T1-report.json'), content: '{}' }, w)));
  allowed(runHook(FILES, payload(wt, 'Write', { file_path: '.superagent/drafts/r1/T1-report.json', content: '{}' }, w)));
  denyReason(runHook(FILES, payload(wt, 'Write', { file_path: join(wt, '.superagent/runs/r1/run.json'), content: '{}' }, w)));
  denyReason(runHook(FILES, payload(wt, 'Write', { file_path: join(wt, '.superagent/drafts/../x.json'), content: '{}' }, w)));
  const wt2 = join(root, '.claude', 'worktrees', 'agent-b2');
  sh(root, ['worktree', 'add', '-q', '-b', 'worker/t2', wt2]);
  writeFileSync(join(root, '.superagent/runs/r1/tickets/T2.json'), JSON.stringify({ id: 'T2', wave: 1, owns: ['apps/api/'], status: 'running', worktree: wt2, branch: 'worker/t2' }));
  assert.match(denyReason(runHook(FILES, payload(wt, 'Write', { file_path: join(wt2, '.superagent/drafts/r1/T2-report.json'), content: '{}' }, w))), /own worktree/);
});
