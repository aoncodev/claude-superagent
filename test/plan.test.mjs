import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRel, ownsPath, overlaps, validatePlan, renderProposal, renderCharter, parseCharter,
} from '../lib/plan.mjs';

function basePlan(over = {}) {
  return {
    title: 'Login page',
    charter: { idea: 'Add a login page', in_scope: ['login form'], out_of_scope: ['SSO'], allowed_actions: [] },
    project: { kind: 'existing', stack: null, setup: [], checks: ['npm test'], integration_checks: [] },
    contracts: [{ id: 'C1', title: 'Auth API', path: 'docs/auth.md' }],
    tickets: [
      { id: 'T1', title: 'Contracts', kind: 'contracts', wave: 1, scope: 'Define auth API', owns: ['docs/'], reads: [], contracts: [], done_when: ['doc exists'] },
      { id: 'T2', title: 'API', kind: 'work', wave: 2, scope: 'Build API', owns: ['src/api/'], reads: [], contracts: ['C1'], done_when: ['tests pass'] },
      { id: 'T3', title: 'UI', kind: 'work', wave: 2, scope: 'Build UI', owns: ['src/ui/'], reads: [], contracts: ['C1'], done_when: ['renders'] },
    ],
    ...over,
  };
}

const errs = (plan) => validatePlan(plan);
const has = (list, re) => list.some((e) => re.test(e));

test('ownsPath is segment-aware', () => {
  assert.equal(ownsPath(['src/api'], 'src/api/x.ts'), true);
  assert.equal(ownsPath(['src/api'], 'src/api-client/x.ts'), false);
  assert.equal(ownsPath(['src/api/'], 'src/api'), false);
  assert.equal(ownsPath(['README.md'], 'README.md'), true);
  assert.equal(ownsPath(['src/api'], 'src/api'), true);
  assert.equal(ownsPath(['src/api/'], 'src/api/x.ts'), true);
  assert.equal(ownsPath(['README.md'], 'README.md.bak'), false);
  assert.equal(ownsPath(['src/api'], 'src/api/../other/x.ts'), false);
  assert.equal(ownsPath(['src/api'], '../src/api/x.ts'), false);
});

test('normalizeRel resolves dot segments', () => {
  assert.equal(normalizeRel('apps/web/../api/x.ts'), 'apps/api/x.ts');
  assert.equal(normalizeRel('../x'), null);
  assert.equal(normalizeRel('/etc/x'), null);
  assert.equal(normalizeRel('./src/a.ts'), 'src/a.ts');
  assert.equal(normalizeRel('src//a///b.ts'), 'src/a/b.ts');
  assert.equal(normalizeRel('src/api/'), 'src/api/');
  assert.equal(normalizeRel('a/../..'), null);
  assert.equal(normalizeRel(''), null);
  assert.equal(normalizeRel('.'), null);
  assert.equal(normalizeRel(42), null);
});

test('overlaps finds prefix overlap', () => {
  assert.equal(overlaps(['src/'], ['src/a.ts']).length, 1);
  assert.equal(overlaps(['src/a/'], ['src/b/']).length, 0);
  assert.equal(overlaps(['src/a/b.ts'], ['src/a/']).length, 1);
  assert.equal(overlaps(['src/api'], ['src/api-client/']).length, 0);
  assert.equal(overlaps(['x.ts'], ['x.ts']).length, 1);
});

test('validatePlan accepts a good plan', () => {
  assert.deepEqual(errs(basePlan()), []);
});

test('validatePlan rejects same-wave overlap naming both ticket ids', () => {
  const p = basePlan();
  p.tickets[2].owns = ['src/api/routes/'];
  const e = errs(p);
  assert.ok(has(e, /T2.*T3|T3.*T2/), e.join('\n'));
});

test('validatePlan accepts the same path in different waves', () => {
  const p = basePlan();
  p.tickets[2].wave = 3;
  p.tickets[2].owns = ['src/api/routes/'];
  assert.deepEqual(errs(p), []);
});

test('validatePlan rejects duplicate ticket ids and bad id shapes', () => {
  let p = basePlan();
  p.tickets[2].id = 'T2';
  assert.ok(has(errs(p), /T2.*duplicate/));
  p = basePlan();
  p.tickets[2].id = 'task-3';
  assert.ok(has(errs(p), /task-3.*T<number>/));
});

test('validatePlan rejects bad owns', () => {
  let p = basePlan();
  p.tickets[1].owns = [];
  assert.ok(has(errs(p), /T2.*owns/));
  p = basePlan();
  p.tickets[1].owns = ['../outside/'];
  assert.ok(has(errs(p), /T2.*owns entry/));
  p = basePlan();
  p.tickets[1].owns = ['/abs/path'];
  assert.ok(has(errs(p), /T2.*owns entry/));
  p = basePlan();
  p.tickets[1].owns = ['src/**/*.ts'];
  assert.ok(has(errs(p), /T2.*glob/));
});

test('validatePlan rejects empty idea, unknown action, bad parallelism', () => {
  let p = basePlan();
  p.charter.idea = '   ';
  assert.ok(has(errs(p), /charter\.idea/));
  p = basePlan();
  p.charter.allowed_actions = ['push', 'teleport'];
  assert.ok(has(errs(p), /teleport/));
  for (const n of [0, 9]) {
    p = basePlan({ parallelism: n });
    assert.ok(has(errs(p), /parallelism/), `parallelism ${n}`);
  }
  assert.deepEqual(errs(basePlan({ parallelism: 8 })), []);
});

test('validatePlan rejects unknown contract ids', () => {
  const p = basePlan();
  p.tickets[1].contracts = ['C9'];
  assert.ok(has(errs(p), /T2.*C9/));
});

test('validatePlan enforces scaffold rules', () => {
  const scaffold = { id: 'T0', title: 'Scaffold', kind: 'scaffold', wave: 0, scope: 'Init project', owns: ['package.json', 'src/'], reads: [], contracts: [], done_when: [] };
  let p = basePlan();
  p.tickets.unshift(scaffold);
  assert.ok(has(errs(p), /T0.*scaffold.*existing/));
  p = basePlan({ project: { kind: 'new', stack: 'node', setup: [], checks: [], integration_checks: [] } });
  p.tickets.unshift({ ...scaffold });
  assert.deepEqual(errs(p), []);
  p.tickets[0].wave = 1; // shares wave 1 with the contracts ticket
  p.tickets[0].owns = ['package.json'];
  assert.ok(has(errs(p), /T0.*alone.*T1/));
});

test('validatePlan rejects work in a wave earlier than a contracts ticket', () => {
  const p = basePlan();
  p.tickets[1].wave = 0;
  const e = errs(p);
  assert.ok(has(e, /T2.*before contracts ticket T1/), e.join('\n'));
});

test('validatePlan reports every error, not just the first', () => {
  const p = basePlan();
  p.charter.idea = '';
  p.tickets[1].owns = [];
  p.tickets[2].contracts = ['C7'];
  assert.ok(errs(p).length >= 3);
});

test('validatePlan survives garbage input', () => {
  assert.ok(errs(null).length > 0);
  assert.ok(errs({}).length > 0);
  assert.ok(errs({ tickets: [null, 5, {}] }).length > 0);
});

test('renderProposal includes the verbatim idea, waves in order, owns, and the blocked line', () => {
  const p = basePlan();
  p.charter.idea = 'Логин sahifasi — add login\nsecond line';
  const out = renderProposal({ parallelism: 4 }, p);
  assert.ok(out.includes('> Логин sahifasi — add login'));
  assert.ok(out.includes('> second line'));
  assert.ok(out.includes('push, deploy, publish and production access are blocked'));
  assert.ok(out.indexOf('Wave 1') < out.indexOf('Wave 2 (parallel)'));
  assert.ok(out.includes('T2 · API — owns src/api/'));
  assert.ok(out.includes('C1 · Auth API → docs/auth.md'));
  assert.match(out, /Parallel workers: 4/);
  assert.ok(!out.includes('Stack'));
});

test('renderProposal shows the stack for new projects and scaffold wave label; allowed actions are listed', () => {
  const p = basePlan({ project: { kind: 'new', stack: 'Node + SQLite', setup: ['npm i'], checks: ['npm test'], integration_checks: [] }, parallelism: 3 });
  p.charter.allowed_actions = ['push'];
  p.tickets.unshift({ id: 'T0', title: 'Scaffold', kind: 'scaffold', wave: 0, scope: 'Init', owns: ['package.json'], reads: [], contracts: [], done_when: [] });
  const out = renderProposal({ parallelism: 4 }, p);
  assert.ok(out.includes('Stack'));
  assert.ok(out.includes('Node + SQLite'));
  assert.ok(out.includes('Wave 0 (scaffold)'));
  assert.ok(!out.includes('push, deploy, publish and production access are blocked'));
  assert.match(out, /Allowed outward actions: push/);
  assert.match(out, /Parallel workers: 3/);
});

test('renderProposal stays near one screen for 12 tickets', () => {
  const p = basePlan();
  p.contracts = [];
  p.tickets = Array.from({ length: 12 }, (_, i) => ({
    id: `T${i + 1}`, title: `Task ${i + 1}`, kind: 'work', wave: 1 + (i % 3), scope: 'x'.repeat(400),
    owns: [`pkg${i}/`], reads: [], contracts: [], done_when: [],
  }));
  assert.ok(renderProposal({ parallelism: 4 }, p).split('\n').length <= 60);
});

test('renderCharter keeps the idea byte-identical and parseCharter round-trips', () => {
  const idea = '  Логин sahifasi — add login\n\n## In scope\n- fake *markdown* `code`\n\n';
  const spec = { title: 'T', rev: 2, idea, in_scope: ['a', 'b'], out_of_scope: [], allowed_actions: ['push', 'deploy'] };
  const text = renderCharter(spec);
  assert.ok(text.startsWith('# Charter r2 — T\n'));
  assert.ok(text.includes(`## Idea (verbatim)\n${idea}\n\n## In scope\n`));
  const back = parseCharter(text);
  assert.equal(back.idea, idea);
  assert.deepEqual(back.in_scope, ['a', 'b']);
  assert.deepEqual(back.out_of_scope, []);
  assert.deepEqual(back.allowed_actions, ['push', 'deploy']);
  assert.deepEqual(parseCharter(renderCharter({ ...spec, allowed_actions: [] })).allowed_actions, []);
});
