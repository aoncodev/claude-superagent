import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideBash, decideFileWrite, guarded, pickWorktree } from '../lib/guard.mjs';

// A fake main checkout with a worker worktree living inside it, as in real runs.
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'superagent-guard-')));
  const wtPath = join(root, '.claude', 'worktrees', 'agent-a1');
  mkdirSync(join(wtPath, 'apps', 'web'), { recursive: true });
  mkdirSync(join(wtPath, 'apps', 'api'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  const worktree = { path: wtPath, branch: 'worker/t1', isMain: false };
  const main = { path: root, branch: 'main', isMain: true };
  const ticket = { id: 'T1', owns: ['apps/web/'], worktree: wtPath, status: 'running' };
  return { root, wtPath, worktree, main, ticket };
}
// Before the first approval a run has no integration branch; afterwards it always has one.
const run = (phase, extra = {}) => ({
  id: 'r1', phase, allowed_actions: [], integration_branch: ['proposing', 'awaiting_approval'].includes(phase) ? null : 'superagent/r1', ...extra,
});
const denied = (r) => { assert.equal(r.allow, false, 'expected deny'); return r.reason; };

// ---- decideFileWrite ----

test('rule 1: writes under .superagent/runs/ are denied in every phase', () => {
  const f = fixture();
  for (const phase of ['proposing', 'running', 'done']) {
    const reason = denied(decideFileWrite({
      absPath: join(f.root, '.superagent/runs/r1/charter.r1.md'), root: f.root, run: run(phase), tickets: [], worktree: f.main,
    }));
    assert.match(reason, /Run state is changed only through the superagent CLI/);
  }
});

test('rule 1: denied with no run at all, and via .. and mixed-case tricks', () => {
  const f = fixture();
  for (const p of ['.superagent/runs/r1/run.json', '.superagent/drafts/../runs/r1/run.json', '.SuperAgent/Runs/r1/run.json', '.superagent/./runs/x']) {
    denied(decideFileWrite({ absPath: `${f.root}/${p}`, root: f.root, run: null, tickets: [], worktree: null }));
  }
});

test('rule 1: allowed siblings (drafts, look-alike names) when no run is active', () => {
  const f = fixture();
  assert.deepEqual(decideFileWrite({ absPath: join(f.root, '.superagent/drafts/r1/plan.json'), root: f.root, run: null, tickets: [], worktree: f.main }), { allow: true });
  assert.deepEqual(decideFileWrite({ absPath: join(f.root, '.superagent/runsabc/x'), root: f.root, run: null, tickets: [], worktree: f.main }), { allow: true });
  assert.deepEqual(decideFileWrite({ absPath: join(f.root, '.superagent/config.json.bak'), root: f.root, run: null, tickets: [], worktree: f.main }), { allow: true });
});

test('drafts are writable in every phase, including running from a worker', () => {
  const f = fixture();
  for (const phase of ['proposing', 'running', 'merging', 'verifying']) {
    const r = decideFileWrite({
      absPath: join(f.root, '.superagent/drafts/r1/T1.json'), root: f.root, run: run(phase), tickets: [f.ticket], worktree: f.main,
    });
    assert.deepEqual(r, { allow: true }, phase);
  }
});

test('drafts symlinked to elsewhere are not a free pass', () => {
  const f = fixture();
  mkdirSync(join(f.root, '.superagent/drafts'), { recursive: true });
  symlinkSync(join(f.root, 'src'), join(f.root, '.superagent/drafts/link'));
  denied(decideFileWrite({
    absPath: join(f.root, '.superagent/drafts/link/x.ts'), root: f.root, run: run('running'), tickets: [], worktree: f.main,
  }));
  mkdirSync(join(f.root, '.superagent/runs/r1'), { recursive: true });
  symlinkSync(join(f.root, '.superagent/runs/r1'), join(f.root, '.superagent/drafts/runs-link'));
  denied(decideFileWrite({
    absPath: join(f.root, '.superagent/drafts/runs-link/charter.r1.md'), root: f.root, run: run('proposing'), tickets: [], worktree: f.main,
  }));
});

test('rule 2: no run, or a non-active phase, allows everything else', () => {
  const f = fixture();
  const abs = join(f.root, 'src/a.ts');
  assert.deepEqual(decideFileWrite({ absPath: abs, root: f.root, run: null, tickets: [], worktree: f.main }), { allow: true });
  for (const phase of ['proposing', 'awaiting_approval', 'done', 'aborted']) {
    assert.deepEqual(decideFileWrite({ absPath: abs, root: f.root, run: run(phase), tickets: [], worktree: f.main }), { allow: true }, phase);
  }
});

test('rule 3: a worker may write inside its owned paths', () => {
  const f = fixture();
  const r = decideFileWrite({
    absPath: join(f.wtPath, 'apps/web/page.tsx'), root: f.root, run: run('running'), tickets: [f.ticket], worktree: f.worktree,
  });
  assert.deepEqual(r, { allow: true });
});

test('rule 3: a worker is denied outside its owned paths, with the handback sentence', () => {
  const f = fixture();
  const reason = denied(decideFileWrite({
    absPath: join(f.wtPath, 'apps/api/x.ts'), root: f.root, run: run('running'), tickets: [f.ticket], worktree: f.worktree,
  }));
  assert.match(reason, /apps\/web\//);
  assert.match(reason, /T1/);
  assert.match(reason, /Out-of-scope needs go in your report's handbacks\./);
});

test('rule 3: apps/web/../api/x.ts from a worker owning apps/web/ is denied', () => {
  const f = fixture();
  denied(decideFileWrite({
    absPath: `${f.wtPath}/apps/web/../api/x.ts`, root: f.root, run: run('running'), tickets: [f.ticket], worktree: f.worktree,
  }));
});

test('rule 3: sibling directories with a shared name prefix are not owned', () => {
  const f = fixture();
  denied(decideFileWrite({
    absPath: join(f.wtPath, 'apps/web-extra/x.ts'), root: f.root, run: run('running'), tickets: [f.ticket], worktree: f.worktree,
  }));
});

test('rule 3: a symlink inside the worktree pointing outside the owned dir is denied', () => {
  const f = fixture();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'superagent-outside-')));
  symlinkSync(outside, join(f.wtPath, 'apps/web/escape'));
  symlinkSync(join(f.wtPath, 'apps/api'), join(f.wtPath, 'apps/web/to-api'));
  for (const rel of ['apps/web/escape/x.ts', 'apps/web/to-api/x.ts']) {
    denied(decideFileWrite({
      absPath: join(f.wtPath, rel), root: f.root, run: run('running'), tickets: [f.ticket], worktree: f.worktree,
    }));
  }
});

test('rule 3: link/../x.ts is judged by where the symlink really leads', () => {
  const f = fixture();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'superagent-outside-')));
  mkdirSync(join(outside, 'deep'));
  symlinkSync(join(outside, 'deep'), join(f.wtPath, 'apps/web/link'));
  // Lexically this is apps/web/x.ts (owned); the OS resolves it to <outside>/x.ts.
  denied(decideFileWrite({
    absPath: `${f.wtPath}/apps/web/link/../x.ts`, root: f.root, run: run('running'), tickets: [f.ticket], worktree: f.worktree,
  }));
});

test('rule 3: a symlink that stays inside the owned dir is allowed; a dangling one pointing out is denied', () => {
  const f = fixture();
  mkdirSync(join(f.wtPath, 'apps/web/real'));
  symlinkSync(join(f.wtPath, 'apps/web/real'), join(f.wtPath, 'apps/web/alias'));
  assert.deepEqual(decideFileWrite({
    absPath: join(f.wtPath, 'apps/web/alias/x.ts'), root: f.root, run: run('running'), tickets: [f.ticket], worktree: f.worktree,
  }), { allow: true });
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'superagent-outside-')));
  symlinkSync(join(outside, 'not-yet'), join(f.wtPath, 'apps/web/dangling'));
  denied(decideFileWrite({
    absPath: join(f.wtPath, 'apps/web/dangling'), root: f.root, run: run('running'), tickets: [f.ticket], worktree: f.worktree,
  }));
});

test('rule 3: a symlink in the main checkout leading into a worker tree is judged by the worker tree', () => {
  const f = fixture();
  symlinkSync(join(f.wtPath, 'apps/api'), join(f.root, 'src/sneaky'));
  denied(decideFileWrite({
    absPath: join(f.root, 'src/sneaky/x.ts'), root: f.root, run: run('merging'), tickets: [f.ticket],
    worktree: f.worktree, lexicalWorktree: f.main,
  }));
});

test('rule 3: the worktree root itself and paths with different casing of an unknown dir are not owned', () => {
  const f = fixture();
  denied(decideFileWrite({ absPath: f.wtPath, root: f.root, run: run('running'), tickets: [f.ticket], worktree: f.worktree }));
});

test('rule 4: a worktree no ticket has claimed is denied with the claim hint', () => {
  const f = fixture();
  const reason = denied(decideFileWrite({
    absPath: join(f.wtPath, 'apps/web/page.tsx'), root: f.root, run: run('running'), tickets: [{ ...f.ticket, worktree: null }], worktree: f.worktree,
  }));
  assert.match(reason, /Run `superagent claim <ticket>` from your worktree first\./);
});

test('rule 5: the main checkout is read-only while running', () => {
  const f = fixture();
  const reason = denied(decideFileWrite({
    absPath: join(f.root, 'src/a.ts'), root: f.root, run: run('running'), tickets: [f.ticket], worktree: f.main,
  }));
  assert.match(reason, /The main checkout is read-only while a wave runs; workers edit only in their worktrees\./);
});

test('rule 5: a path inside a linked worktree is never treated as the main checkout', () => {
  const f = fixture();
  // Even if the caller hands over the main worktree for a path that is physically inside the linked one,
  // pickWorktree (used by the hooks) resolves it to the longest prefix.
  const trees = [f.main, f.worktree];
  assert.equal(pickWorktree(join(f.wtPath, 'apps/web/x.ts'), trees).isMain, false);
  assert.equal(pickWorktree(join(f.root, 'src/x.ts'), trees).isMain, true);
  assert.equal(pickWorktree('/somewhere/else/x.ts', trees), null);
});

test('rule 5: the main checkout is writable while merging', () => {
  const f = fixture();
  assert.deepEqual(decideFileWrite({
    absPath: join(f.root, 'src/a.ts'), root: f.root, run: run('merging'), tickets: [f.ticket], worktree: f.main,
  }), { allow: true });
});

test('rule 6: verifying/reviewing main writes, and paths outside every worktree, are allowed', () => {
  const f = fixture();
  for (const phase of ['verifying', 'reviewing']) {
    assert.deepEqual(decideFileWrite({ absPath: join(f.root, 'src/a.ts'), root: f.root, run: run(phase), tickets: [], worktree: f.main }), { allow: true });
  }
  assert.deepEqual(decideFileWrite({ absPath: '/tmp/unrelated.txt', root: f.root, run: run('running'), tickets: [], worktree: null }), { allow: true });
});

test('deny reasons may mention the agent type, but ownership never depends on it', () => {
  const f = fixture();
  const base = { absPath: join(f.wtPath, 'apps/web/page.tsx'), root: f.root, run: run('running'), tickets: [f.ticket], worktree: f.worktree };
  assert.deepEqual(decideFileWrite({ ...base, agentType: 'superagent:orchestrator' }), { allow: true });
  assert.deepEqual(decideFileWrite({ ...base, agentType: 'superagent:worker' }), { allow: true });
});

test('an injected realpath is used for symlink resolution', () => {
  const f = fixture();
  const realpath = (p) => (p.includes('/virtual/') ? '/elsewhere/x.ts' : p);
  denied(decideFileWrite({
    absPath: join(f.wtPath, 'apps/web/virtual/x.ts'), root: f.root, run: run('running'), tickets: [f.ticket], worktree: f.worktree, realpath,
  }));
});

// ---- decideBash ----

const cfg = { production_markers: [] };
const B = (command, extra = {}) => decideBash({ command, run: run('running', extra), config: cfg });

test('decideBash: chained, prefixed and wrapped outward commands are denied', () => {
  for (const c of [
    'cd app && git push origin main',
    'npm test; git push',
    'FOO=1 git push',
    'sudo docker push x',
    'npm test || git push --force',
    'echo hi | tee x\ngit push',
    'git -C ../other push',
    'env GIT_SSH=x git push',
    '(cd x && git push)',
    'bash -c "heroku releases"',
    'gh pr merge 12 --squash',
    'echo "git push"', // known limitation: quoted text is not parsed
  ]) {
    const reason = denied(B(c));
    assert.match(reason, /Blocked: `push` is not in this run's approved Charter\.|Blocked: `deploy`/, c);
  }
});

test('decideBash: deny reason names the action and how to allow it', () => {
  assert.equal(denied(B('git push')), 'Blocked: `push` is not in this run\'s approved Charter. Ask the user; a Charter revision can allow it.');
});

test('decideBash: deploy and publish commands are denied', () => {
  const deploy = ['vercel --prod', 'vercel deploy --prod', 'npx vercel --prod', 'netlify deploy --prod', 'fly deploy', 'flyctl deploy', 'railway up', 'heroku releases',
    'kubectl apply -f x.yml', 'kubectl -n prod delete pod x', 'kubectl rollout restart deploy/a', 'helm install a b', 'helm upgrade a b', 'terraform apply', 'terraform destroy',
    'pulumi up', 'serverless deploy', 'sls deploy', 'firebase deploy', 'docker push img', '/usr/local/bin/terraform apply -auto-approve'];
  for (const c of deploy) assert.match(denied(B(c)), /`deploy`/, c);
  const publish = ['npm publish', 'pnpm publish', 'yarn publish', 'cargo publish', 'twine upload dist/*', 'gh release create v1', 'eas submit', 'fastlane ios release', 'pnpm exec fastlane x'];
  for (const c of publish) assert.match(denied(B(c)), /`publish`/, c);
});

test('decideBash: allowed_actions lifts exactly the listed action', () => {
  assert.deepEqual(B('git push', { allowed_actions: ['push'] }), { allow: true });
  assert.deepEqual(B('cd a && git push', { allowed_actions: ['push'] }), { allow: true });
  denied(B('npm publish', { allowed_actions: ['push'] }));
  assert.deepEqual(B('npm publish && docker push x', { allowed_actions: ['publish', 'deploy'] }), { allow: true });
});

test('decideBash: ordinary commands are allowed', () => {
  for (const c of ['git status', "git commit -m 'no push here'", 'git log --oneline', 'npm test', 'cat heroku.md', 'git commit -m "add fastlane notes"',
    'vercel dev', 'netlify status', 'kubectl get pods', 'terraform plan', 'docker build .', 'git diff main...HEAD', 'ls | grep push', 'cargo build']) {
    assert.deepEqual(B(c), { allow: true }, c);
  }
});

test('decideBash: production marker in any part is denied unless production is allowed', () => {
  const config = { production_markers: ['db.prod.example.com'] };
  const cmd = 'psql -h db.prod.example.com -c "select 1"';
  assert.match(denied(decideBash({ command: cmd, run: run('running'), config })), /`production`/);
  assert.deepEqual(decideBash({ command: cmd, run: run('running', { allowed_actions: ['production'] }), config }), { allow: true });
  assert.deepEqual(decideBash({ command: 'psql -h localhost', run: run('running'), config }), { allow: true });
  assert.deepEqual(decideBash({ command: 'echo hi', run: run('running'), config: { production_markers: [''] } }), { allow: true });
});

test('decideBash: outward actions are not checked outside active phases', () => {
  for (const phase of ['proposing', 'awaiting_approval', 'done']) {
    assert.deepEqual(decideBash({ command: 'git push', run: run(phase), config: cfg }), { allow: true }, phase);
  }
  assert.deepEqual(decideBash({ command: 'git push', run: null, config: cfg }), { allow: true });
  for (const phase of ['running', 'merging', 'verifying', 'reviewing']) {
    denied(decideBash({ command: 'git push', run: run(phase), config: cfg }));
  }
});

test('decideBash: writes under .superagent/runs/ are denied even with every action allowed', () => {
  const all = { allowed_actions: ['push', 'deploy', 'publish', 'production'] };
  for (const c of [
    'echo x > .superagent/runs/r/charter.r1.md',
    'echo x >> /repo/.superagent/runs/r/events.jsonl',
    'echo x 2>.superagent/runs/r/a',
    'echo x &> .superagent/runs/r/a',
    'cat a | tee .superagent/runs/r/run.json',
    'tee -a .superagent/runs/r/run.json < a',
    'rm -rf .superagent/runs',
    'rm .superagent/runs/r/tickets/T1.json',
    'mv a.md .superagent/runs/r/charter.r1.md',
    'cp a.md .superagent/runs/r/charter.r1.md',
    'sed -i s/a/b/ .superagent/runs/r/run.json',
    'sed -i.bak s/a/b/ .superagent/runs/r/run.json',
    'echo x > .superagent/drafts/../runs/r/run.json',
    'cd .superagent/runs/r && echo x > run.json',
    'sudo rm .superagent/runs/r/run.json',
    'echo ok; echo x > "$ROOT/.superagent/runs/r/run.json"',
  ]) {
    assert.match(denied(decideBash({ command: c, run: run('running', all), config: cfg })), /Run state is changed only through the superagent CLI/, c);
  }
});

test('decideBash: runs-dir protection applies even with no run, and reads are fine', () => {
  assert.match(denied(decideBash({ command: 'echo x > .superagent/runs/r/run.json', run: null, config: cfg })), /superagent CLI/);
  for (const c of ['cat .superagent/runs/r/run.json', 'cat .superagent/runs/r/run.json > /tmp/out', 'cp .superagent/runs/r/charter.r1.md /tmp/c.md',
    'ls .superagent/runs', 'echo x > .superagent/drafts/r/plan.json', 'sed s/a/b/ .superagent/runs/r/run.json', 'grep -r foo .superagent/runs']) {
    assert.deepEqual(decideBash({ command: c, run: run('running', { allowed_actions: ['push'] }), config: cfg }), { allow: true }, c);
  }
});

test('decideBash: non-string commands are allowed', () => {
  assert.deepEqual(decideBash({ command: undefined, run: run('running'), config: cfg }), { allow: true });
});

// ---- fix round 1 ----

test('fix 1: rm/mv/cp aimed at the .superagent parent dir are denied (also via glob or absolute path)', () => {
  const all = { allowed_actions: ['push', 'deploy', 'publish', 'production'] };
  for (const c of [
    'rm -rf .superagent', 'rm -rf .superagent/', 'mv .superagent /tmp/x', 'rm -rf /repo/.superagent', 'rm -rf ./.superagent',
    'rm -rf ../.superagent', 'rm -rf .superagent/*', 'rm -rf .superagent/r*', 'cp -r /tmp/x .superagent', 'mv /tmp/x /repo/.superagent/',
  ]) {
    assert.match(denied(decideBash({ command: c, run: run('running', all), config: cfg })), /superagent CLI/, c);
  }
  for (const c of ['rm -rf .superagent/drafts/r1', 'rm -rf .superagent/d*', 'cp .superagent/config.json /tmp/c', 'ls .superagent', 'rm -rf .superagent-old', 'rm -rf src/.superagent-x']) {
    assert.deepEqual(decideBash({ command: c, run: run('running', all), config: cfg }), { allow: true }, c);
  }
});

test('fix 3: quote and escape evasion of outward commands is denied', () => {
  for (const c of [`git "push" origin`, `git 'push' origin`, 'git pu\\sh', 'g\\it push', 'git -C "a b" push', `git -C 'a b' push origin`,
    `"git" push`, `git p""ush`, `git $'push'`, `FOO="a b" git push`, `sudo "docker" "push" x`, `"npm" publish`, `'heroku' releases`, `bash -c 'git "push"'`]) {
    denied(B(c));
  }
  assert.deepEqual(B(`git commit -m "push"`), { allow: true });
  assert.deepEqual(B(`git -C "a b" status`), { allow: true });
});

test('fix 4: line continuation does not hide a command', () => {
  denied(B('git \\\npush origin main'));
  denied(B('git \\\r\n  push'));
  assert.match(denied(B('echo x > .superagent/\\\nruns/r/run.json')), /superagent CLI/);
  assert.deepEqual(B('git \\\nstatus'), { allow: true });
});

test('fix 5: cd into .superagent (or beyond) makes relative runs/ operands count', () => {
  for (const c of [
    'cd .superagent && echo x > runs/r1/run.json',
    'cd .superagent && sed -i s/a/b/ runs/r1/run.json',
    'cd .superagent && rm -rf runs',
    'cd .superagent && rm -rf *',
    'cd .superagent && rm -rf .',
    'cd .superagent; mv runs /tmp/x',
    'cd /repo/.superagent && tee runs/r1/run.json',
    'cd .superagent/runs && rm -rf r1',
    'cd .superagent/runs/r1 && echo x > ../r2/run.json',
    'cd .superagent && cd runs && rm r1/run.json',
    'cd .superagent/drafts && echo x > ../runs/r1/run.json',
    'cd .superagent && rm -rf ../.superagent',
  ]) {
    assert.match(denied(B(c, { allowed_actions: ['push'] })), /superagent CLI/, c);
  }
  for (const c of ['cd .superagent && cat runs/r1/run.json', 'cd .superagent && echo x > drafts/r1/plan.json', 'cd .superagent && cd .. && rm -rf runs',
    'cd src && rm -rf runs', 'cd .superagent/drafts && rm -rf r1']) {
    assert.deepEqual(B(c, { allowed_actions: ['push'] }), { allow: true }, c);
  }
});

test('fix 6: git clean -x/-X is denied during an active run regardless of allowed_actions', () => {
  const all = ['push', 'deploy', 'publish', 'production'];
  for (const c of ['git clean -fdx', 'git clean -xfd', 'git clean -fdX', 'git clean -f -d -x', 'git clean -x', 'git -C sub clean -fdx', 'cd src && git clean -ffdx', 'git "clean" -fdx', 'sudo git clean -fxd']) {
    assert.match(denied(B(c, { allowed_actions: all })), /git clean/, c);
  }
  for (const c of ['git clean -fd', 'git clean -n', 'git clean -fdn src/', 'git status -x']) assert.deepEqual(B(c), { allow: true }, c);
  for (const phase of ['proposing', 'done']) assert.deepEqual(decideBash({ command: 'git clean -fdx', run: run(phase), config: cfg }), { allow: true });
});

test('fix 7: a worker may not write into another linked worktree', () => {
  const f = fixture();
  const wt2 = join(f.root, '.claude', 'worktrees', 'agent-b2');
  mkdirSync(join(wt2, 'apps', 'api'), { recursive: true });
  const worktree2 = { path: wt2, branch: 'worker/t2', isMain: false };
  const ticket2 = { id: 'T2', owns: ['apps/api/'], worktree: wt2, status: 'running' };
  const base = { absPath: join(wt2, 'apps/api/a.ts'), root: f.root, run: run('running'), tickets: [f.ticket, ticket2], worktree: worktree2 };
  assert.match(denied(decideFileWrite({ ...base, cwdWorktree: f.worktree })), /You may only edit inside your own worktree\./);
  assert.deepEqual(decideFileWrite({ ...base, cwdWorktree: worktree2 }), { allow: true });
  assert.deepEqual(decideFileWrite({ ...base, cwdWorktree: f.main }), { allow: true }); // orchestrator in the main checkout
  assert.deepEqual(decideFileWrite({ ...base, cwdWorktree: null }), { allow: true });
});

// ---- final review: guards ----

test('regression #2: guarded() needs an integration branch and a phase other than done/aborted', () => {
  assert.equal(guarded(null), false);
  assert.equal(guarded(run('proposing')), false);
  assert.equal(guarded(run('awaiting_approval')), false, 'first approval pending: nothing is running yet');
  assert.equal(guarded(run('awaiting_approval', { integration_branch: 'superagent/r1' })), true, 'a revised charter awaiting re-approval');
  for (const phase of ['running', 'merging', 'verifying', 'reviewing']) assert.equal(guarded(run(phase)), true, phase);
  for (const phase of ['done', 'aborted']) assert.equal(guarded(run(phase)), false, phase);
});

test('regression #2: while a revised charter awaits re-approval every guard stays on', () => {
  const f = fixture();
  const revised = run('awaiting_approval', { integration_branch: 'superagent/r1' });
  assert.match(denied(decideBash({ command: 'git push origin HEAD', run: revised, config: cfg })), /`push`/);
  assert.match(denied(decideBash({ command: 'git clean -fdx', run: revised, config: cfg })), /git clean/);
  denied(decideFileWrite({ absPath: join(f.wtPath, 'apps/api/evil.ts'), root: f.root, run: revised, tickets: [f.ticket], worktree: f.worktree, cwdWorktree: f.worktree }));
  assert.deepEqual(decideFileWrite({ absPath: join(f.wtPath, 'apps/web/ok.ts'), root: f.root, run: revised, tickets: [f.ticket], worktree: f.worktree, cwdWorktree: f.worktree }), { allow: true });
  // rule 5: workers may still be live, so the main checkout stays read-only, for the orchestrator too
  assert.match(denied(decideFileWrite({ absPath: join(f.root, 'src/a.ts'), root: f.root, run: revised, tickets: [f.ticket], worktree: f.main, cwdWorktree: f.main })), /read-only/);
});

test('regression #4: file tools may not write .superagent/active or .superagent/config.json, with or without a run', () => {
  const f = fixture();
  for (const r of [null, run('proposing'), run('running'), run('done')]) {
    for (const p of ['.superagent/active', '.superagent/config.json', '.SuperAgent/Config.json', '.superagent/drafts/../active']) {
      assert.match(denied(decideFileWrite({ absPath: `${f.root}/${p}`, root: f.root, run: r, tickets: [], worktree: f.main })), /superagent CLI/, p);
    }
  }
  // a worker's view of its own worktree copy is denied as well
  denied(decideFileWrite({ absPath: join(f.wtPath, '.superagent/config.json'), root: f.root, run: run('running'), tickets: [f.ticket], worktree: f.worktree, cwdWorktree: f.worktree }));
});

test('regression #4: Bash writes to .superagent/active or .superagent/config.json are denied; reads and drafts are fine', () => {
  const all = { allowed_actions: ['push', 'deploy', 'publish', 'production'] };
  for (const c of [
    'rm .superagent/active', 'rm -f /repo/.superagent/active', 'echo x > .superagent/active', 'echo other-run > /repo/.superagent/active',
    'mv /tmp/c .superagent/config.json', "echo '{}' > .superagent/config.json", 'sed -i s/a/b/ .superagent/config.json', 'tee .superagent/config.json',
    'cp /tmp/c .superagent/config.json', 'rm .superagent/a*', 'rm .superagent/c*', 'cd .superagent && rm active', 'truncate -s0 .superagent/config.json',
  ]) {
    assert.match(denied(decideBash({ command: c, run: run('running', all), config: cfg })), /superagent CLI/, c);
    assert.match(denied(decideBash({ command: c, run: null, config: cfg })), /superagent CLI/, `${c} (no run)`);
  }
  for (const c of ['cat .superagent/active', 'cat .superagent/config.json', 'cp .superagent/config.json /tmp/c', 'echo x > .superagent/drafts/r/a', 'rm -rf .superagent/drafts/r1', 'ls .superagent/']) {
    assert.deepEqual(decideBash({ command: c, run: run('running', all), config: cfg }), { allow: true }, c);
  }
});

test('regression #14: a worker (cwd in a linked worktree) may not write into the main checkout in any guarded phase', () => {
  const f = fixture();
  const phases = [run('running'), run('merging'), run('verifying'), run('reviewing'), run('awaiting_approval', { integration_branch: 'superagent/r1' })];
  for (const r of phases) {
    const reason = denied(decideFileWrite({ absPath: join(f.root, 'src/a.ts'), root: f.root, run: r, tickets: [f.ticket], worktree: f.main, cwdWorktree: f.worktree }));
    assert.match(reason, /own worktree|read-only/, r.phase);
    // main-checkout drafts stay writable
    assert.deepEqual(decideFileWrite({ absPath: join(f.root, '.superagent/drafts/r1/x.json'), root: f.root, run: r, tickets: [f.ticket], worktree: f.main, cwdWorktree: f.worktree }), { allow: true });
  }
  // the orchestrator in the main checkout may still resolve a merge
  assert.deepEqual(decideFileWrite({ absPath: join(f.root, 'src/a.ts'), root: f.root, run: run('merging'), tickets: [f.ticket], worktree: f.main, cwdWorktree: f.main }), { allow: true });
});

test('T6: git stash -a/--all is denied while guarded; other stashes are fine', () => {
  const all = ['push', 'deploy', 'publish', 'production'];
  for (const c of ['git stash -a', 'git stash --all', 'git stash push -a', 'git stash push --all -m x', 'git stash save -a', 'git -C sub stash -a', 'cd x && git stash push -ka', 'git "stash" --all']) {
    assert.match(denied(B(c, { allowed_actions: all })), /git stash/, c);
  }
  for (const c of ['git stash', 'git stash -u', 'git stash push -u -m "superagent: r1"', 'git stash pop', 'git stash apply', 'git stash list', 'git stash push -m all']) {
    assert.deepEqual(B(c), { allow: true }, c);
  }
  assert.deepEqual(decideBash({ command: 'git stash -a', run: run('proposing'), config: cfg }), { allow: true });
});

// ---- worker callers may not run orchestrator commands ----

const W = (command, extra = {}) => decideBash({ command, run: run('awaiting_approval', extra), config: cfg, fromWorker: true });

test('decideBash: a worker may not run orchestrator-only superagent commands, however disguised', () => {
  for (const c of [
    'superagent approve',
    'cd /repo && superagent approve',
    'cd /repo; superagent reapprove',
    '/plugin/bin/superagent approve',
    'node /plugin/bin/superagent.mjs approve',
    'env FOO=1 superagent revise-charter c.md',
    "bash -c 'cd /repo && superagent approve'",
    'superagent "approve"',
    'superagent merge T1',
    'superagent finish',
    'superagent abort',
    'superagent answer T1 --text yes',
    'superagent add-ticket t.json',
  ]) {
    assert.match(denied(W(c)), /orchestrator/, c);
  }
});

test('decideBash: a worker may still run worker commands, and the orchestrator may run anything', () => {
  for (const c of ['superagent claim T1', 'superagent brief T1', 'superagent report T1 --file r.json', 'superagent show --run', 'superagent status', 'superagent check-diff T1', 'superagent']) {
    assert.deepEqual(W(c), { allow: true }, c);
  }
  assert.deepEqual(decideBash({ command: 'superagent approve', run: run('awaiting_approval'), config: cfg }), { allow: true });
  assert.deepEqual(decideBash({ command: 'echo superagent approve', run: run('running'), config: cfg, fromWorker: true }), { allow: true });
});

test('decideBash: the worker check applies even when the run is not guarded', () => {
  assert.match(denied(decideBash({ command: 'superagent approve', run: null, config: cfg, fromWorker: true })), /orchestrator/);
});

// ---- reviewer isolation (v0.2) ----

const MAIN = '/repo/main';
const reviewerReason = /Blocked: the fidelity reviewer works only in its review worktree and must not read run state\./;
const R = (command, extra = {}) => decideBash({ command, run: null, config: cfg, reviewer: true, mainRoot: MAIN, ...extra });

test('reviewer isolation: commands naming the main checkout or run state are denied', () => {
  for (const c of [
    `cat ${MAIN}/.superagent/runs/r1/run.json`,
    `cat ${MAIN}/README.md`,
    `cd ${MAIN} && ls`,
    `git -C ${MAIN} status`,
    `cd ${MAIN.toUpperCase()} && ls`, // case-insensitive
    'cat .superagent/runs/r1/run.json',
    'cd .superagent/runs && ls',
    'ls .SUPERAGENT/RUNS/r1',
  ]) {
    assert.match(denied(R(c)), reviewerReason, c);
  }
});

test('reviewer isolation: ordinary reads inside the review worktree are allowed', () => {
  for (const c of [
    'git diff abc123..superagent/r1', 'git status', 'git log --oneline', 'superagent show --run',
    'superagent show --charter', 'ls', 'cat README.md', 'npm test', 'cd /tmp/superagent-review-r1-abc && ls',
  ]) {
    assert.deepEqual(R(c), { allow: true }, c);
  }
});

test('reviewer isolation: applies even when the run is not guarded or absent', () => {
  for (const r of [null, run('proposing'), run('done')]) {
    assert.match(denied(decideBash({ command: `cd ${MAIN} && ls`, run: r, config: cfg, reviewer: true, mainRoot: MAIN })), reviewerReason, String(r?.phase));
    assert.match(denied(decideBash({ command: `cat ${MAIN}/.superagent/runs/x`, run: r, config: cfg, reviewer: true, mainRoot: MAIN })), reviewerReason, String(r?.phase));
  }
});

test('reviewer isolation: run-state writes stay denied with the reviewer reason', () => {
  const all = { allowed_actions: ['push', 'deploy', 'publish', 'production'] };
  for (const c of [
    `echo x > ${MAIN}/.superagent/runs/r1/run.json`,
    `rm -rf ${MAIN}`,
    'echo x > .superagent/runs/r1/run.json',
    'mv a .superagent/runs/r1/charter.r1.md',
  ]) {
    assert.match(denied(R(c, { run: run('running', all) })), reviewerReason, c);
  }
  // A run-state write that names neither the main root nor runs/ keeps the ordinary reason.
  assert.match(denied(R('rm .superagent/active')), /Run state is changed only through the superagent CLI\./);
  assert.match(denied(R('echo x > .superagent/config.json')), /Run state is changed only through the superagent CLI\./);
});

test('reviewer isolation: mainRoot is optional; without it only run-state references are denied', () => {
  assert.match(denied(decideBash({ command: 'cat .superagent/runs/x', run: null, config: cfg, reviewer: true })), reviewerReason);
  assert.deepEqual(decideBash({ command: `cd ${MAIN} && ls`, run: null, config: cfg, reviewer: true }), { allow: true });
  assert.deepEqual(decideBash({ command: `cd ${MAIN} && ls`, run: null, config: cfg, reviewer: true, mainRoot: '' }), { allow: true });
  // Without reviewer, the same command is untouched.
  assert.deepEqual(decideBash({ command: `cd ${MAIN} && ls`, run: null, config: cfg }), { allow: true });
});

// ---- v0.2.1 finding 7: reviewer Bash hardening ----

test('fix 7: the reviewer may mention .superagent only as .superagent/drafts', () => {
  for (const c of [
    'cat .superagent/drafts/r1/review.json',
    'ls .superagent/drafts',
    'tail -n 5 "$REVIEW/.superagent/drafts/r1/review.json"',
    'cd .superagent/drafts && cat r1/review.json',
  ]) assert.deepEqual(R(c), { allow: true }, c);
  for (const c of [
    'cat .superagent/active',
    'cat .superagent/config.json',
    'cat .superagent/ru*/run.json',
    'ls .superagent/ru*',
    'cat .SUPERAGENT/ACTIVE',
    'cat ./.superagent/active',
    'cd .superagent && cat runs/r1/run.json',
    'cd .superagent/drafts && cat ../runs/r1/run.json',
    'cat .superagent/drafts/../runs/r1/run.json',
  ]) assert.match(denied(R(c)), reviewerReason, c);
});

test('fix 7: a git range to a superagent branch is not a run-state mention', () => {
  assert.deepEqual(R('git diff abc123..superagent/r1'), { allow: true });
  assert.deepEqual(R('git diff abc123...superagent/r1'), { allow: true });
  assert.deepEqual(R('git log --oneline -- superagent/r1'), { allow: true });
});

test('fix 7: the reviewer may not run superagent show --json, in either flag order or the node form', () => {
  for (const c of [
    'superagent show --json',
    'superagent show --json --run',
    'superagent show --run --json',
    'superagent show --charter --json',
    'superagent show --json=true',
    'superagent show --run --json=true',
    '/plugin/bin/superagent show --json',
    'node /plugin/bin/superagent.mjs show --json',
    'node ../bin/superagent.mjs show --run --json',
    'env FOO=1 superagent show --json',
    "bash -c 'superagent show --json'",
  ]) assert.match(denied(R(c)), /superagent show --json/);
  for (const c of ['superagent show --run', 'superagent show --charter', 'superagent show', 'node /plugin/bin/superagent.mjs show --run']) {
    assert.deepEqual(R(c), { allow: true }, c);
  }
});

test('fix 7: the new reviewer rules apply with no run and never touch other callers', () => {
  for (const r of [null, run('proposing'), run('done')]) {
    assert.match(denied(decideBash({ command: 'cat .superagent/active', run: r, config: cfg, reviewer: true, mainRoot: MAIN })), reviewerReason, String(r?.phase));
    assert.match(denied(decideBash({ command: 'superagent show --json', run: r, config: cfg, reviewer: true, mainRoot: MAIN })), /show --json/, String(r?.phase));
  }
  for (const c of ['cat .superagent/active', 'superagent show --json']) {
    assert.deepEqual(decideBash({ command: c, run: null, config: cfg }), { allow: true }, c);
    assert.deepEqual(decideBash({ command: c, run: null, config: cfg, fromWorker: true }), { allow: true }, c);
  }
});
