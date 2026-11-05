import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTIVE_PHASES, decideBash, decideFileWrite, pickWorktree } from '../lib/guard.mjs';

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
const run = (phase, extra = {}) => ({ id: 'r1', phase, allowed_actions: [], ...extra });
const denied = (r) => { assert.equal(r.allow, false, 'expected deny'); return r.reason; };

test('ACTIVE_PHASES lists the phases in which a run is live', () => {
  assert.deepEqual(ACTIVE_PHASES, ['running', 'merging', 'verifying', 'reviewing']);
});

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

test('rule 1: allowed siblings (drafts, config) when no run is active', () => {
  const f = fixture();
  assert.deepEqual(decideFileWrite({ absPath: join(f.root, '.superagent/config.json'), root: f.root, run: null, tickets: [], worktree: f.main }), { allow: true });
  assert.deepEqual(decideFileWrite({ absPath: join(f.root, '.superagent/runsabc/x'), root: f.root, run: null, tickets: [], worktree: f.main }), { allow: true });
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
