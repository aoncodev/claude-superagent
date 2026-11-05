# Claude Superagent Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `superagent`, a standalone Claude Code plugin that turns one idea into an approved split of Tickets, runs them in parallel worker subagents in isolated git worktrees, and merges, verifies and fidelity-reviews the result against the user's frozen Charter.

**Architecture:** A dependency-free Node CLI (`bin/superagent.mjs`) owns all run state in `<repo>/.superagent/` and every deterministic rule: plan validation, path ownership, report validation, diff checks, merges, and fix-wave limits. Two PreToolUse hooks call the same pure guard functions to enforce ownership, Charter immutability, and outward-action blocking. Prompts carry only judgement: the orchestrator skill (split, route, ask, merge loop) and the worker and fidelity-reviewer agent definitions. Prompts always act through the CLI and never edit state files by hand.

**Tech Stack:** Node ≥ 22 (ESM `.mjs`, no npm dependencies), `node:test`, git, Claude Code plugin format (`.claude-plugin/plugin.json`, `commands/`, `skills/`, `agents/`, `hooks/hooks.json`).

**Spec:** `docs/design/spec.md`

## Global Constraints

- Plugin root: `/Users/aon/superagent/claude-superagent/` (its own git repo). Plugin name `superagent`, so commands are `/superagent:start`, `/superagent:status`, `/superagent:resume`, `/superagent:abort`.
- No dependency on the Superpowers plugin, and no name collisions with it.
- No npm dependencies; Node built-ins only. Tests: `node --test test/`.
- No stack-specific logic in the core. Setup, check, and integration commands are discovered by the orchestrator and stored in the run.
- Default parallelism **4**, allowed range 1–8, overridable in `.superagent/config.json` and per run.
- Worker report `summary` is **at most 100 words**. A `blocked` report carries **exactly one** `question`.
- Automatic fix waves: at most **1** after failed verification, and at most **1** after fidelity review (unmet items only). Extras are never auto-removed.
- Outward actions (`push`, `deploy`, `publish`, `production`) are **blocked**, not confirmed, unless the frozen Charter's `allowed_actions` lists them. The user runs with permission prompts bypassed, so nothing may rely on a permission prompt.
- `.superagent/` is git-ignored through `.git/info/exclude`; the user's `.gitignore` is never modified.
- Hooks with no active run, or with unreadable state, must allow the action and write a one-line warning to stderr. They must never block a session that is not running a superagent run.
- Owned paths are repo-relative POSIX path prefixes (a file, or a directory ending in `/`), never globs.

## Review Focus

1. **Path tricks in file writes:** `..` segments, relative `file_path`, and symlinked directories must be resolved before ownership is checked. A worker writing `apps/web/../api/x.ts` is outside `apps/web/`. (Pinned in Task 3 and Task 6.)
2. **Prefix false matches:** an owned `src/api` must not grant `src/api-client/x.ts`. Ownership is segment-aware. (Pinned in Task 3.)
3. **Corrupt or missing state:** a malformed `run.json` or a deleted `.superagent/` makes hooks allow the action with a stderr warning, and makes the CLI print a clear error naming the file. Neither crashes or blocks unrelated work. (Pinned in Task 6.)
4. **Chained shell commands:** `cd app && git push origin main`, `npm test; git push`, and `FOO=1 git push` are all caught as pushes. (Pinned in Task 6.)
5. **Dirty working tree at approval:** `approve` refuses with a message listing the dirty files. It does not stash or discard anything. (Pinned in Task 2.)

---

## File Structure

```
claude-superagent/
  .claude-plugin/plugin.json        plugin manifest
  .claude-plugin/marketplace.json   local marketplace so the plugin can be installed from this folder
  package.json                      "type":"module", "test":"node --test test/"
  bin/superagent.mjs                CLI entry: argument parsing and command dispatch only
  lib/git.mjs                       git subprocess helpers
  lib/state.mjs                     .superagent layout, run/ticket/event/config read-write
  lib/plan.mjs                      plan validation, ownership, overlap, proposal rendering
  lib/report.mjs                    worker report and fidelity review validation
  lib/status.mjs                    status rendering (needs-you first)
  lib/guard.mjs                     pure allow/deny decisions shared by both hooks
  lib/commands/*.mjs                one file per CLI command group (run, plan, ticket, merge, review)
  hooks/hooks.json                  PreToolUse registrations
  hooks/guard-files.mjs             stdin → decideFileWrite → hook JSON
  hooks/guard-bash.mjs              stdin → decideBash → hook JSON
  agents/worker.md                  worker subagent definition
  agents/fidelity-reviewer.md       fidelity reviewer subagent definition
  skills/orchestrate/SKILL.md       orchestrator procedure
  skills/orchestrate/proposal-format.md
  commands/start.md, status.md, resume.md, abort.md
  test/helpers.mjs                  temp git repos, CLI and hook runners
  test/*.test.mjs
  docs/platform-notes.md            verified Claude Code behaviours (Task 1)
  README.md
```

### Shared data types (used by every task)

```js
// .superagent/config.json (optional)
Config = { parallelism?: number, production_markers?: string[], worker_model?: string }

// .superagent/runs/<id>/run.json
Run = {
  id: string,                 // "20261106-1432-<slug>"
  title: string,
  phase: "proposing"|"awaiting_approval"|"running"|"merging"|"verifying"|"reviewing"|"done"|"aborted",
  created_at: string,         // ISO
  repo_root: string,          // absolute path of the main checkout
  charter_rev: number,        // 1-based; file charter.r<rev>.md
  charter_sha256: string|null,// set on approve; frozen when non-null
  allowed_actions: ("push"|"deploy"|"publish"|"production")[],
  project: { kind: "existing"|"new", stack: string|null, setup: string[], checks: string[], integration_checks: string[] } | null,
  parallelism: number,
  base_branch: string|null, base_sha: string|null, integration_branch: string|null, // set on approve
  current_wave: number|null,
  fix_waves_used: { fix: number, fidelity: number }
}

// .superagent/runs/<id>/tickets/<T>.json
Ticket = {
  id: string,                 // /^T\d+$/
  title: string,
  kind: "scaffold"|"contracts"|"work"|"fix",
  wave: number,
  scope: string,              // outcome, not steps
  owns: string[], reads: string[], contracts: string[], done_when: string[],
  status: "planned"|"running"|"ready"|"blocked"|"failed"|"dropped"|"merged",
  origin: "plan"|"handback"|"fix"|"fidelity",
  agent_id: string|null, worktree: string|null, branch: string|null,
  attempts: number,
  answer: string|null         // the user's answer to this ticket's last question
}

// Input to `superagent propose`
Plan = {
  title: string,
  charter: { idea: string, in_scope: string[], out_of_scope: string[], allowed_actions: string[] },
  project: Run["project"],
  contracts: { id: string, title: string, path: string }[],   // id /^C\d+$/
  tickets: Omit<Ticket, "status"|"origin"|"agent_id"|"worktree"|"branch"|"attempts"|"answer">[],
  parallelism?: number
}

// Input to `superagent report`
Report = {
  status: "ready"|"blocked"|"failed"|"dropped",
  summary: string, changed_files: string[], branch: string, commits: string[],
  checks: { command: string, passed: boolean }[],
  handbacks: { need: string, reason: string }[],
  question?: { text: string, options?: string[] },
  progress?: string   // required for blocked/failed: what is done and what remains
}

// Input to `superagent review`
Review = { unmet: { item: string, evidence: string }[], extras: { item: string, evidence: string }[], contradictions: { item: string, evidence: string }[] }
```

State files: `.superagent/active` (run id), `.superagent/runs/<id>/{run.json, charter.r<N>.md, contracts.json, tickets/<T>.json, reports/<T>-<attempt>.json, reviews/<n>.json, events.jsonl}`, `.superagent/drafts/` (orchestrator scratch, writable).

---

### Task 1: Verify platform behaviours and create the plugin skeleton

The plan assumes the following. Confirm each one, record the facts in `docs/platform-notes.md`, and apply the listed fallback if an assumption is false. Later tasks read this file.

| # | Assumption | Fallback if false |
|---|---|---|
| A1 | PreToolUse hook stdin JSON includes `cwd`, `tool_name`, `tool_input` (`file_path` for Write/Edit, `command` for Bash), and inside a subagent also identifies the subagent (`agent_id`/`agent_type` or similar) | Without a subagent identity, the hooks rely on path → worktree mapping only (already the design) |
| A2 | A hook printing `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}` blocks the tool even in bypass-permissions mode | Use exit code 2 with the reason on stderr |
| A3 | Agent tool `isolation: "worktree"` creates a worktree whose HEAD is the main checkout's current HEAD, and the subagent's Bash cwd is that worktree | If it branches from elsewhere, `superagent claim` runs `git reset --hard <integration_branch>` in the fresh worktree before work starts (it is empty of changes at claim time) |
| A4 | `${CLAUDE_PLUGIN_ROOT}` is expanded inside command and skill markdown, and/or the plugin's `bin/` is on PATH for Bash | Commands and skills call `node "<root>/bin/superagent.mjs"`, with the root resolved by a `SessionStart` hook that writes it to `CLAUDE_ENV_FILE` as `SUPERAGENT_BIN` |
| A5 | A plugin's agents are addressable as `superagent:worker` in the Agent tool, and a finished background agent can be continued with SendMessage | If not continuable, a blocked worker resumes as a fresh worker (the cross-session path, already designed) |
| A6 | The plugin installs from a local marketplace (`/plugin marketplace add <path>`, then `/plugin install superagent@superagent-local`) | Document the working install method in the README |

**Files:**
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `package.json`, `hooks/hooks.json` (probe version), `hooks/probe.mjs` (temporary), `docs/platform-notes.md`, `test/helpers.mjs`, `test/smoke.test.mjs`

**Interfaces:**
- Produces: `test/helpers.mjs` → `makeRepo({ commit = true } = {}): string` (temp dir with `git init`, user config, and one commit when `commit`); `runCli(args: string[], { cwd: string, input?: string }): { code: number, stdout: string, stderr: string }`; `runHook(script: string, payload: object): { code, stdout, stderr }`.

- [ ] **Step 1:** `git init` the plugin root. Write `plugin.json` (`name: "superagent"`, version `0.1.0`, description, author `Aon`), a `marketplace.json` named `superagent-local` listing the plugin with `"source": "./"`, and `package.json` with `"type":"module"` and `"scripts": {"test": "node --test test/"}`.
- [ ] **Step 2:** Write `hooks/probe.mjs`, which appends its stdin JSON as one line to `$TMPDIR/superagent-probe.jsonl` and exits 0. Register it in `hooks/hooks.json` for PreToolUse with matcher `Write|Edit|Bash`, command `node "${CLAUDE_PLUGIN_ROOT}/hooks/probe.mjs"`.
- [ ] **Step 3:** Install the plugin from the local marketplace (A6). In a throwaway git repo, have Claude: run one Bash command; spawn one `general-purpose` agent with `isolation: "worktree"` that runs `pwd && git rev-parse HEAD && git branch --show-current` and writes one file; then SendMessage that agent once (A5). Inspect the probe log for A1 and A3. Run a temporary deny probe (always deny `echo PROBE-DENY`) under bypass mode for A2. Check A4 by having a temporary command run `echo ${CLAUDE_PLUGIN_ROOT}` and `which superagent`.
- [ ] **Step 4:** Write `docs/platform-notes.md` with one section per assumption: observed fact, raw evidence (trimmed JSON or output), and which fallback applies. Remove `probe.mjs` and the probe registrations.
- [ ] **Step 5:** Write `test/helpers.mjs` and `test/smoke.test.mjs` with `test('makeRepo creates a committed repo', …)` asserting that `git rev-parse HEAD` succeeds in the returned dir. Run `node --test test/`. Expected: 1 pass.
- [ ] **Step 6:** Commit: `chore: plugin skeleton and verified platform notes`.

---

### Task 2: Run state store, git helpers, and run lifecycle commands

**Files:**
- Create: `lib/git.mjs`, `lib/state.mjs`, `lib/commands/run.mjs`, `bin/superagent.mjs`
- Test: `test/state.test.mjs`, `test/cli-run.test.mjs`

**Interfaces:**
- Produces (`lib/git.mjs`): `git(args: string[], cwd: string): string` (trimmed stdout; throws `Error` whose message includes stderr); `mainRoot(cwd: string): string` (absolute main checkout root via `git rev-parse --path-format=absolute --git-common-dir`, then its parent; correct from inside any worktree); `worktreeContaining(absPath: string, root: string): { path: string, branch: string|null, isMain: boolean } | null` (longest-prefix match over `git worktree list --porcelain`); `dirtyFiles(cwd: string): string[]` (porcelain paths excluding `.superagent/`); `diffNames(cwd: string, from: string, to: string): string[]` (`git diff --name-only from...to`); `hasHead(cwd): boolean`.
- Produces (`lib/state.mjs`): `stateDir(root): string`; `ensureStateDir(root): void` (creates `.superagent/` and adds `.superagent/` to `.git/info/exclude` once); `readConfig(root): Required<Config>` (defaults `{parallelism:4, production_markers:[], worker_model:"inherit"}`); `createRun(root, { title }): Run` (phase `proposing`, sets `.superagent/active`); `activeRunId(root): string|null`; `loadRun(root, id): Run` (throws `StateError` naming the file on missing or invalid JSON); `saveRun(root, run): void` (atomic write via temp file + rename); `loadTickets(root, id): Ticket[]` (sorted by wave, then numeric id); `saveTicket(root, id, t): void`; `appendEvent(root, id, type: string, data?: object): void` (one JSON line `{ts, type, ...data}`); `charterPath(root, run): string`; `readCharter(root, run): string`.
- Produces (CLI): `superagent init --title <t> [--git-init]`, `superagent approve`, `superagent abort`, `superagent show [--json | --charter]` (`--charter` prints the current charter file verbatim; `--json` prints `{run, tickets, lastReports}`), `superagent phase <phase>`. Every command accepts `--run <id>`, defaulting to the active run. Exit codes: 0 ok, 1 usage or validation error, 2 state error, 3 git conflict or refusal.

- [ ] **Step 1: Write failing tests** in `test/state.test.mjs`:
  - `createRun writes run.json with phase proposing and sets active`: `activeRunId(root) === run.id`; `loadRun` deep-equals the returned run.
  - `ensureStateDir adds .superagent/ to .git/info/exclude exactly once`: after two calls, the exclude file contains the line once, and `git status --porcelain` stays empty.
  - `loadRun on invalid JSON throws StateError naming run.json`.
  - `mainRoot from inside a linked worktree returns the main checkout`: `git worktree add` in a temp repo, then call from the worktree.
  - `readConfig defaults parallelism to 4`; `readConfig rejects parallelism 9 with StateError`.
- [ ] **Step 2:** Run `node --test test/state.test.mjs`. Expected: FAIL, modules missing.
- [ ] **Step 3:** Implement `lib/git.mjs` and `lib/state.mjs` per the Interfaces (`execFileSync('git', args, { cwd })`; never use a shell).
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Write failing CLI tests** in `test/cli-run.test.mjs`:
  - `init in a non-repo without --git-init exits 1 and says to pass --git-init`.
  - `init --git-init in an empty dir creates a repo with an initial empty commit` (`hasHead` true afterwards).
  - `approve refuses when phase is not awaiting_approval` (exit 1).
  - `approve refuses on a dirty tree and lists the dirty files` (Review Focus 5): create an untracked `a.txt`, set the phase to `awaiting_approval` via `superagent phase awaiting_approval`, then run `approve`. Expect exit 3, stdout containing `a.txt`, and the file still present.
  - `approve on a clean tree freezes the charter`: after Task 3's `propose` exists this is covered there. Here, assert only that `charter_sha256` is set, `integration_branch === "superagent/<run id>"` is checked out, `base_branch` and `base_sha` are recorded, and the phase is `running`, with `current_wave` set to the lowest ticket wave (or `null` when there are no tickets).
  - `abort sets phase aborted, clears active, and leaves branches untouched`.
- [ ] **Step 6:** Implement `lib/commands/run.mjs` and the `bin/superagent.mjs` dispatcher (a hand-written argv parser for `--flag value` and boolean flags). `approve` computes `charter_sha256` over the current charter file, creates and checks out `superagent/<run-id>` from HEAD, and appends the event `approved`.
- [ ] **Step 7:** Run `node --test test/`. Expected: all pass.
- [ ] **Step 8:** Commit: `feat: run state store and lifecycle commands`.

---

### Task 3: Plan validation, ownership rules, and the split proposal

**Files:**
- Create: `lib/plan.mjs`, `lib/commands/plan.mjs`
- Test: `test/plan.test.mjs`, `test/cli-plan.test.mjs`

**Interfaces:**
- Consumes: `lib/state.mjs` (Task 2).
- Produces: `normalizeRel(p: string): string|null` (POSIX, strips `./`, collapses `..`; returns `null` for absolute paths or paths escaping the root); `ownsPath(owns: string[], rel: string): boolean`; `overlaps(a: string[], b: string[]): [string, string][]`; `validatePlan(plan: Plan): string[]` (empty array means valid); `renderProposal(run: Run, plan: Plan): string`.
- Produces (CLI): `superagent propose <plan.json>` (validates, then writes `charter.r1.md`, `contracts.json`, `tickets/*.json`, sets `project`, `allowed_actions` and `parallelism` on the run, sets the phase to `awaiting_approval`, and prints the proposal; on errors prints them one per line and exits 1). Re-running `propose` before approval replaces the plan. `superagent revise-charter <file>` (after approval only: writes `charter.r<N+1>.md`, clears `charter_sha256`, sets the phase to `awaiting_approval`, and appends event `charter_revised`). `superagent proposal` reprints the stored proposal.

Ownership rule: an entry ending in `/` owns every path under that directory. An entry without a trailing `/` owns that exact file and, if it names a directory, everything under it. Matching compares whole path segments.

Charter file format (verbatim idea first, never reworded):

```markdown
# Charter r1 — <title>

## Idea (verbatim)
<idea exactly as given>

## In scope
- …
## Out of scope
- …
## Allowed outward actions
none — push, deploy, publish and production access are blocked
```

- [ ] **Step 1: Write failing tests** in `test/plan.test.mjs`:
  - `ownsPath is segment-aware` (Review Focus 2): `ownsPath(['src/api'], 'src/api/x.ts') === true`, `ownsPath(['src/api'], 'src/api-client/x.ts') === false`, `ownsPath(['src/api/'], 'src/api') === false`, `ownsPath(['README.md'], 'README.md') === true`.
  - `normalizeRel resolves dot segments` (Review Focus 1): `normalizeRel('apps/web/../api/x.ts') === 'apps/api/x.ts'`, `normalizeRel('../x') === null`, `normalizeRel('/etc/x') === null`.
  - `overlaps finds prefix overlap`: `overlaps(['src/'], ['src/a.ts'])` has length 1; `overlaps(['src/a/'], ['src/b/'])` has length 0.
  - `validatePlan rejects same-wave overlap` naming both ticket ids; `accepts the same path in different waves`.
  - `validatePlan rejects`: duplicate ticket ids; an id not matching `/^T\d+$/`; empty `owns`; an `owns` entry that normalizes to null; an empty `charter.idea`; an unknown allowed action; `parallelism` 0 or 9; a ticket listing an unknown contract id; a `scaffold` ticket when `project.kind` is `existing`; a `scaffold` ticket sharing its wave with another ticket; a `work` ticket in a wave earlier than any `contracts` ticket.
  - `renderProposal includes the verbatim idea, the waves in order, each ticket's owns, and "push, deploy, publish and production access are blocked" when allowed_actions is empty`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement `lib/plan.mjs`. `renderProposal` output, in order: title; Charter (idea as a blockquote, in/out of scope, allowed actions); Stack (only for `new` projects); Contracts (`C1 · title → path`); one block per wave (`Wave 2 (parallel)` / `Wave 0 (scaffold)`), one line per ticket (`T4 · <title> — owns <owns joined by ", ">`) plus an indented scope line; the line `Parallel workers: N`. Keep it to roughly one screen for 12 tickets (each ticket takes at most 2 lines).
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Write failing CLI tests** in `test/cli-plan.test.mjs`:
  - `propose writes the charter verbatim`: an idea containing non-ASCII text (`"Логин sahifasi — add login"`) and Markdown is byte-identical inside `charter.r1.md` under `## Idea (verbatim)`.
  - `propose with an invalid plan exits 1, prints every error, and leaves the phase as proposing`.
  - `propose then approve freezes the charter and sets current_wave to the lowest wave` (completes Task 2's approve test).
  - `revise-charter before approve exits 1`; `revise-charter after approve writes r2 and returns to awaiting_approval`.
- [ ] **Step 6:** Implement `lib/commands/plan.mjs` and wire it into the dispatcher.
- [ ] **Step 7:** Run `node --test test/`. Expected: all pass.
- [ ] **Step 8:** Commit: `feat: plan validation, ownership rules and split proposal`.

---

### Task 4: Ticket execution commands: claim, worker brief, reports, answers, added tickets

**Files:**
- Create: `lib/report.mjs`, `lib/commands/ticket.mjs`
- Test: `test/report.test.mjs`, `test/cli-ticket.test.mjs`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces: `wordCount(text: string): number` (whitespace-separated tokens; a CJK character counts as one word); `validateReport(r: Report): string[]`.
- Produces (CLI):
  - `superagent start-ticket <T> --agent <id>`: status `running`, `attempts += 1`, records `agent_id`, event `ticket_started`. Refused unless the phase is `running` and the ticket's wave equals `current_wave`.
  - `superagent claim <T>`: run from inside the worker's worktree. Records `worktree` (the `git rev-parse --show-toplevel` of cwd) and `branch`. Refuses (exit 3) when cwd is the main checkout. Copies every untracked, git-ignored file matching `.env*` at the main root's top level into the worktree, without overwriting. Event `ticket_claimed`.
  - `superagent brief <T>`: prints the worker's whole input, in this order: the Charter verbatim; the contracts the ticket lists (id, title, path); the ticket's title, scope, owns, reads, and done_when; the run's `project.setup` and `project.checks`; if `attempts > 1`, the previous report's `progress` and `question`, and the ticket's `answer`.
  - `superagent report <T> --file <json>`: validates the report and writes `reports/<T>-<attempt>.json`. Sets the ticket status to the report's status. Appends one event `handback` per handback. Prints `ok` and exits 0, or prints the errors and exits 1 without changing state.
  - `superagent answer <T> --text <s>`: stores `answer` and sets status `running`, event `answered`. Refused unless the status is `blocked`.
  - `superagent add-ticket --file <json> --origin handback|fix|fidelity`: validates the ticket against the stored plan rules: no overlap with not-yet-merged tickets in the same wave; a `wave` greater than every merged wave. `fix` and `fidelity` add-ticket increment `fix_waves_used[origin]` the first time a ticket lands in a new wave, and refuse (exit 3, message "automatic fix wave limit reached; report to the user") when that wave would be the second for that origin.

Report rules (`validateReport`): status is in the enum; summary is non-empty with `wordCount ≤ 100`; `question` is present if and only if status is `blocked`, with `question.text` non-empty; `progress` is required for `blocked` and `failed`; `checks` is an array of `{command, passed}`; and when status is `ready`, `commits` is non-empty and every check passed.

- [ ] **Step 1: Write failing tests** in `test/report.test.mjs`, one `test` per rule above: `a 101-word summary is rejected`; `a blocked report without a question is rejected`; `a ready report with a question is rejected`; `a ready report with a failing check is rejected`; `a ready report without commits is rejected`; `a failed report without progress is rejected`; `a valid ready report has no errors`; `wordCount("登录 页面 add login") === 5`.
- [ ] **Step 2:** Run the tests and confirm they fail. Implement `lib/report.mjs`. Run them again and confirm they pass.
- [ ] **Step 3: Write failing CLI tests** in `test/cli-ticket.test.mjs` (use `git worktree add` to stand in for the Agent tool's worktree):
  - `claim from the main checkout exits 3`.
  - `claim copies an untracked .env but not a tracked .env.example and never overwrites`.
  - `brief starts with the verbatim charter and includes the previous question and answer on attempt 2`.
  - `report with an invalid report exits 1 and leaves the ticket running`.
  - `report blocked then answer then start-ticket increments attempts to 2`.
  - `start-ticket refuses a ticket outside current_wave`.
  - `add-ticket --origin fix refuses a second fix wave`.
- [ ] **Step 4:** Implement `lib/commands/ticket.mjs`. Run `node --test test/`. Expected: all pass.
- [ ] **Step 5:** Commit: `feat: ticket claim, brief, report, answer and add-ticket`.

---

### Task 5: Merge, diff check, wave advance, reviews, and status

**Files:**
- Create: `lib/status.mjs`, `lib/commands/merge.mjs`, `lib/commands/review.mjs`
- Test: `test/cli-merge.test.mjs`, `test/status.test.mjs`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces (CLI):
  - `superagent check-diff <T>`: compares `diffNames(root, integration_branch, ticket.branch)` against `ownsPath(ticket.owns, …)`. Prints the violating paths and exits 3 when there are any, otherwise exits 0.
  - `superagent merge <T>`: only for status `ready`. Runs check-diff first: on a violation, the ticket is not merged; its status becomes `failed`, and a `handback` event lists the out-of-scope paths. Otherwise sets the phase to `merging` and runs `git merge --no-ff --no-edit <branch>` on the integration branch in the main checkout. On success: status `merged`, event `merged` with the merge sha, phase back to `running`. On conflict: leaves the merge in progress, prints the conflicted files, exits 3, and keeps the phase at `merging`.
  - `superagent merge-continue`: after the orchestrator resolves a conflict and stages the files, commits the merge and marks the ticket `merged`.
  - `superagent next-wave`: refused while any ticket in `current_wave` is `planned`, `running`, or `blocked`. Otherwise advances `current_wave` to the next wave that has `planned` tickets, or prints `none` and sets the phase to `verifying` when no planned tickets remain.
  - `superagent verify-result --passed true|false [--log <file>]`: event `verified`. On true, phase `reviewing`; on false, the phase stays `verifying`, and the orchestrator decides between a fix wave and reporting.
  - `superagent review --file <json>`: validates the `Review` structure (three arrays of `{item, evidence}`) and writes `reviews/<n>.json`, event `reviewed`.
  - `superagent finish`: phase `done`, event `finished`, clears `.superagent/active`.
  - `superagent status [--json]`: prints `renderStatus`.
- Produces: `renderStatus(run: Run, tickets: Ticket[], lastReports: Record<string, Report>, events: object[]): string`.

`renderStatus` order: the line `Needs you:` followed by one bullet per item, or the line `Nothing needs you.`, where items are: phase `awaiting_approval` ("approve the split"); each `blocked` ticket with its question text; each `failed` or `dropped` ticket with the first sentence of its summary; phase `merging` with a conflict. Then one progress line: `Run <id> · <phase> · wave <current>/<max> · <n> running · <n> merged · <n> planned`. Healthy runs print exactly two lines.

- [ ] **Step 1: Write failing tests** in `test/cli-merge.test.mjs`, using a full fixture flow: init → propose (2 tickets in wave 1 owning `a/` and `b/`) → approve → start-ticket ×2 → worktrees via `git worktree add -b` → claim → commit inside each → report ready:
  - `merge merges both tickets and marks them merged`.
  - `merge rejects a branch that touched a path outside owns` (a commit in `a/` plus `b/x.txt` on T1's branch). Expect exit 3, T1 status `failed`, and the `handback` event listing `b/x.txt`.
  - `merge stops on conflict with phase merging and exit 3`, then `merge-continue after resolving marks merged`. Construct the conflict with a fixture that owns a shared top-level file added by a `contracts` ticket in wave 0.
  - `next-wave is refused while a ticket is blocked`.
  - `next-wave with nothing planned sets phase verifying`.
  - `review rejects a review missing extras`.
- [ ] **Step 2: Write failing tests** in `test/status.test.mjs`: `healthy run prints exactly two lines starting with "Nothing needs you."`; `a blocked ticket's question appears under "Needs you:" before the progress line`; `awaiting_approval lists "approve the split"`.
- [ ] **Step 3:** Run the tests and confirm they fail. Implement `lib/status.mjs`, `lib/commands/merge.mjs`, and `lib/commands/review.mjs`. Run `node --test test/`. Expected: all pass.
- [ ] **Step 4:** Commit: `feat: merge with diff check, wave advance, review and status`.

---

### Task 6: Guard hooks

**Files:**
- Create: `lib/guard.mjs`, `hooks/guard-files.mjs`, `hooks/guard-bash.mjs`; Modify: `hooks/hooks.json`
- Test: `test/guard.test.mjs`, `test/hooks.test.mjs`

**Interfaces:**
- Consumes: `lib/git.mjs`, `lib/state.mjs`, `lib/plan.mjs` (`normalizeRel`, `ownsPath`).
- Produces: `decideFileWrite(ctx: { absPath: string, root: string, run: Run|null, tickets: Ticket[], worktree: {path, branch, isMain}|null }): { allow: true } | { allow: false, reason: string }`; `decideBash(ctx: { command: string, run: Run|null, config: Config }): same`; `ACTIVE_PHASES = ["running","merging","verifying","reviewing"]`.
- Hook output: on deny, the JSON from A2 (or the Task 1 fallback); on allow, exit 0 with no output.

`decideFileWrite` rules, in order:
1. If `absPath` is under `<root>/.superagent/runs/`: deny with "Run state is changed only through the superagent CLI". This applies in every phase, so the Charter cannot be edited by hand. `.superagent/drafts/` is allowed.
2. If there is no run, or the phase is not in `ACTIVE_PHASES`: allow.
3. If the path is inside a non-main worktree claimed by a ticket: allow only when `ownsPath(ticket.owns, rel)` holds, where `rel` is the path relative to that worktree. The rel path is computed after `realpath` of the nearest existing ancestor directory, plus `normalizeRel`. Otherwise deny with a reason naming the ticket's owned paths and the sentence "Out-of-scope needs go in your report's handbacks."
4. If the path is inside a non-main worktree that no ticket has claimed: deny with "Run `superagent claim <ticket>` from your worktree first."
5. If the path is inside the main checkout and the phase is `running`: deny with "The main checkout is read-only while a wave runs; workers edit only in their worktrees." Allowed when the phase is `merging`, so the orchestrator can resolve conflicts.
6. Otherwise allow.

`decideBash` rules apply only when the run phase is in `ACTIVE_PHASES`. Split the command on `&&`, `||`, `;`, `|`, and newlines, then strip leading `VAR=value` assignments and `sudo`/`env`/`command` prefixes from each part. Deny when a part matches and its action is not in `run.allowed_actions`:
- `push`: `git push`, `gh pr merge`
- `deploy`: `vercel --prod`, `vercel deploy --prod`, `netlify deploy --prod`, `fly deploy`, `flyctl deploy`, `railway up`, `heroku`, `kubectl apply|delete|rollout`, `helm install|upgrade`, `terraform apply|destroy`, `pulumi up`, `serverless deploy`, `sls deploy`, `firebase deploy`, `docker push`
- `publish`: `npm publish`, `pnpm publish`, `yarn publish`, `cargo publish`, `twine upload`, `gh release create`, `eas submit`, `fastlane`
- `production`: any `config.production_markers` substring anywhere in the full command
- Also deny, regardless of `allowed_actions`, any part that writes under `.superagent/runs/` through a redirection (`>`, `>>`, `tee`) or through `rm`/`mv`/`cp`/`sed -i` naming that path.

Deny reasons name the action and say how to allow it: "Blocked: `<action>` is not in this run's approved Charter. Ask the user; a Charter revision can allow it."

Hook scripts: read all of stdin, `JSON.parse`, and resolve `root = mainRoot(payload.cwd)`. If `cwd` is not a git repo, or `.superagent/active` is missing, allow silently. On any exception: write `superagent guard: <message> (allowing)` to stderr and exit 0 (Review Focus 3).

- [ ] **Step 1: Write failing tests** in `test/guard.test.mjs`, calling `decideFileWrite` and `decideBash` with constructed contexts:
  - each `decideFileWrite` rule 1–5 has one allow test and one deny test, including `apps/web/../api/x.ts from a worker owning apps/web/ is denied` and a symlink test: a symlink inside the worktree pointing outside the owned dir is denied.
  - `decideBash`: `"cd app && git push origin main"`, `"npm test; git push"`, `"FOO=1 git push"`, `"sudo docker push x"` are denied (Review Focus 4); `"git push"` is allowed when `allowed_actions` includes `push`; `"git status"` and `"git commit -m 'no push here'"` are allowed. **Known limitation:** `echo "git push"` is denied; quoted text is not parsed (the conservative choice).
  - `production marker "db.prod.example.com" in a psql command is denied`.
  - `echo x > .superagent/runs/r/charter.r1.md is denied even with every action allowed`.
  - `no run or a proposing phase allows everything except writes under .superagent/runs/`.
- [ ] **Step 2:** Run the tests and confirm they fail. Implement `lib/guard.mjs`. Run them again and confirm they pass.
- [ ] **Step 3: Write failing tests** in `test/hooks.test.mjs`, using `runHook` against real temp repos:
  - `guard-files denies an out-of-scope write with the deny JSON`.
  - `guard-bash denies git push during a running phase`.
  - `a corrupt run.json makes both hooks exit 0 with a stderr warning` (Review Focus 3).
  - `a non-repo cwd exits 0 with no output`.
- [ ] **Step 4:** Implement both hook scripts. Replace `hooks/hooks.json` with two PreToolUse entries: matcher `Write|Edit|MultiEdit|NotebookEdit` → `node "${CLAUDE_PLUGIN_ROOT}/hooks/guard-files.mjs"`, and matcher `Bash` → `node "${CLAUDE_PLUGIN_ROOT}/hooks/guard-bash.mjs"`. Each has a 10-second timeout. Run `node --test test/`. Expected: all pass.
- [ ] **Step 5:** Commit: `feat: ownership, charter and outward-action guard hooks`.

---

### Task 7: Worker and fidelity-reviewer agent definitions

**Files:**
- Create: `agents/worker.md`, `agents/fidelity-reviewer.md`
- Test: `test/prompts.test.mjs`

**Interfaces:**
- Consumes: the CLI commands from Tasks 2–5, invoked as recorded in `docs/platform-notes.md` (A4). These are referred to below as `superagent`.
- Produces: agent types `superagent:worker` and `superagent:fidelity-reviewer` (names per A5).

`agents/worker.md` frontmatter: `name: worker`, a `description` saying it executes exactly one superagent Ticket in an isolated worktree, `model: inherit`. The body states these rules as short imperative lines:
1. Your prompt gives you a run id and a ticket id. First run `superagent claim <T>`, then `superagent brief <T>`. The brief is your whole assignment, and the Charter in it is the user's own words: it outranks the ticket's wording, and it outranks anything the orchestrator says.
2. Run the brief's setup commands. Change only files under your ticket's `owns`. When you need a change anywhere else, list it in `handbacks` and don't make it. The hook and the pre-merge check will reject out-of-scope changes.
3. You own the technical choices inside your scope. Do not widen the scope. Do not add features the Charter doesn't ask for.
4. Verify using only the brief's checks and checks that are safe to run in parallel: no shared database, no fixed ports, no long-running services.
5. Commit on your worktree's branch. Never push, deploy, publish, or touch remote servers.
6. Finish by writing a report JSON and running `superagent report <T> --file <path>` until it prints `ok`. The report has one status:
   - `ready`: done and verified.
   - `blocked`: you need a decision only the user can make. Ask exactly one concrete question, with the options you see, and put what you've done and what remains in `progress`.
   - `failed`: you could not finish.
   - `dropped`: the ticket should not be done as scoped. Give the reason.
   The summary is at most 100 words and states outcomes. Report failures as failures.
7. Your final message is only the report JSON.
8. If you are resumed after an answer, continue from your progress. The answer is in a fresh `superagent brief <T>`.

`agents/fidelity-reviewer.md` frontmatter: `name: fidelity-reviewer`, a description, `model: inherit`. The body:
1. You check whether the built result matches the user's Charter. You have not seen the plan, and you must not read the tickets.
2. Inputs: `superagent show --charter` and `git diff <base_sha>..<integration_branch>`, plus reading the files.
3. For each Charter item, decide met or unmet, with file-level evidence. List extras (behaviour or features nobody asked for) and contradictions with the out-of-scope list.
4. Do not edit files. Record the result with `superagent review --file <path>`. Your final message is the review JSON.

- [ ] **Step 1: Write failing tests** in `test/prompts.test.mjs`. Parse each agent file's YAML frontmatter with a minimal `key: value` parser and assert `name`, `description`, and `model` are present. Assert that `worker.md` mentions `superagent claim`, `superagent brief`, `superagent report`, `handbacks`, `100 words`, and `exactly one`. Assert that `fidelity-reviewer.md` mentions `superagent review` and `must not read the tickets`.
- [ ] **Step 2:** Run the tests and confirm they fail. Write both agent files. Run them again and confirm they pass.
- [ ] **Step 3:** Commit: `feat: worker and fidelity reviewer agents`.

---

### Task 8: Orchestrator skill and slash commands

**Files:**
- Create: `skills/orchestrate/SKILL.md`, `skills/orchestrate/proposal-format.md`, `commands/start.md`, `commands/status.md`, `commands/resume.md`, `commands/abort.md`
- Test: extend `test/prompts.test.mjs`

**Interfaces:**
- Consumes: every CLI command, plus the agent types from Task 7.

`SKILL.md` frontmatter: `name: orchestrate`, plus a description saying it runs a superagent run (split, parallel workers, merge, verify, fidelity review), and is used by `/superagent:start` and `/superagent:resume`. The body is the procedure, written as numbered phases. Each phase names the exact CLI commands it uses:

1. **Intake.** Take the idea from the arguments, or from the file they point to. Run `superagent init --title <short title>`, offering `--git-init` if the folder isn't a repo.
   - For an existing codebase, find the stack, the setup command, the parallel-safe checks, and the integration checks from project files and CLAUDE.md/AGENTS.md.
   - For an empty folder, propose the stack, matching anything the idea states.
2. **Split.** Write a Plan JSON in `.superagent/drafts/plan.json`:
   - `charter.idea` holds the user's words **verbatim**. Never paraphrase them.
   - Contracts first: API description, schema/migrations, shared types, env var names, folder layout.
   - Shared files (manifests, lockfiles, root config, route registries, CI files) belong to the scaffold or contracts tickets.
   - Ticket scopes state outcomes, not steps, and `done_when` uses parallel-safe checks.
   - Tickets in one wave never share owned paths, and dependent work goes in later waves.
   - Aim for about 5–12 tickets.
   - Run `superagent propose`, and fix any validation errors.
3. **Approval.** Show the printed proposal unchanged, and ask the user to approve it or say what to change (one AskUserQuestion). Revise until approved, then run `superagent approve`. Never start workers before approve succeeds.
4. **Wave loop.** For the current wave, run up to `parallelism` workers at once.
   - For each ticket: run `superagent start-ticket <T> --agent <id>` after launching an Agent call with `subagent_type: superagent:worker` and `isolation: "worktree"`, plus `model` when `config.worker_model` is not `inherit`. The prompt contains only the run id and ticket id. Do not summarise or restate the Charter or the ticket: the worker gets them from `brief`.
   - When a worker finishes, read its report from `superagent show --json`, not from the transcript.
   - `ready`: leave it for the end of the wave. Once no ticket in the wave is `running` or `blocked`, run `superagent merge <T>` for each ready ticket in ticket-id order (contracts and scaffold waves come first by construction). On a conflict, resolve it only when it's in shared files; otherwise report it to the user.
   - `blocked`: ask the user the stored question with AskUserQuestion, one question at a time, most blocking first, while the other workers keep running. Then run `superagent answer`, `superagent start-ticket`, and resume the same agent with SendMessage. If it isn't resumable, launch a fresh worker.
   - `failed`/`dropped`: tell the user briefly, then continue the other tickets.
   - Handbacks: if a handback is inside the Charter, run `superagent add-ticket --origin handback` into a later wave. Otherwise ask the user.
   - When the wave is settled, run `superagent next-wave`.
5. **Verify.** On the integration branch, run `project.setup` and `project.integration_checks`, then `superagent verify-result`. On failure, add one fix wave (`add-ticket --origin fix`), loop, and verify again. If the CLI refuses a second fix wave, go to the final report.
6. **Fidelity review.** Launch `superagent:fidelity-reviewer` with the run id. For unmet items inside the Charter, add one fidelity fix wave, then review again once. Never remove extras: list them for the user.
7. **Final report** (then `superagent finish`):
   - what was built;
   - the merge and verification results;
   - Charter fidelity (met, unmet, extras);
   - failed, dropped, and handed-back tickets;
   - the integration branch name;
   - what the user must do next, such as merging to their main branch or pushing, which only happens if the Charter allows it.

Standing rules, in a short list at the top of SKILL.md:
- You route, merge, and ask; workers implement.
- Never rewrite the Charter or widen a ticket.
- Stay silent during routine progress. Speak only for approval, a question, an unrecoverable failure, and the final report.
- Run `superagent status` to see what needs the user.
- Never edit `.superagent/runs/` by hand.

`proposal-format.md`: the Plan JSON schema (copied from this plan's Shared data types) and one complete worked example. The example is a small full-stack idea split into a contracts wave and two parallel waves (backend endpoint, frontend page, migration, CI job).

Commands (each `.md` has a frontmatter `description` and, where it takes input, `argument-hint`):
- `start.md`: "Use the superagent:orchestrate skill to start a new run for: $ARGUMENTS". Refuses if an active run exists and points to `/superagent:resume` or `/superagent:abort`.
- `status.md`: runs `superagent status` and shows its output verbatim.
- `resume.md`: runs `superagent status`, then follows the orchestrate skill from the run's current phase. Running tickets with no live agent get a fresh worker; blocked tickets get their question asked again.
- `abort.md`: confirms with the user, then runs `superagent abort`, and reports the branches and worktrees left behind for the user to keep or delete.

- [ ] **Step 1: Extend `test/prompts.test.mjs`** with failing tests:
  - SKILL.md frontmatter has `name: orchestrate`;
  - SKILL.md mentions every CLI command used above (`init`, `propose`, `approve`, `start-ticket`, `merge`, `answer`, `add-ticket`, `next-wave`, `verify-result`, `review`, `finish`, `status`);
  - it contains `verbatim` and `isolation`;
  - each command file has a `description`;
  - `start.md` contains `$ARGUMENTS`;
  - `proposal-format.md`'s example JSON block parses and passes `validatePlan`.
- [ ] **Step 2:** Run the tests and confirm they fail. Write the files. Run them again and confirm they pass.
- [ ] **Step 3:** Commit: `feat: orchestrator skill and slash commands`.

---

### Task 9: Install, end-to-end run, and README

**Files:**
- Create: `README.md`, `docs/e2e-checklist.md`
- Modify: anything the end-to-end run proves wrong (with tests added for CLI or hook defects)

- [ ] **Step 1:** Write `README.md`:
  - what the plugin does (one paragraph, with credit to dsh-superagent's ideas);
  - install (the method verified in A6);
  - the four commands;
  - the `.superagent/config.json` fields;
  - outward-action blocking and how a Charter allows an action;
  - known limitations (quoted `git push` text is blocked; Bash writes are caught at merge, not at write time; integration tests run only after the final wave).
- [ ] **Step 2:** Reinstall the plugin. In a new empty folder, run `/superagent:start` with the idea: *"A todo app: Express + SQLite backend with REST endpoints for todos, a React (Vite) frontend listing and adding todos, a migration creating the todos table, and a GitHub Actions workflow running the tests."* Record in `docs/e2e-checklist.md` whether each of the following holds, with evidence:
  - the proposal fits one screen and shows the stack, scaffold wave, contracts wave, and at least two parallel tickets;
  - nothing is built before approval;
  - at least two workers ran at the same time;
  - each worker edited only its own worktree, and a deliberate out-of-scope write was denied by the hook;
  - `git push` from a worker was denied;
  - every ticket merged with no unexplained conflict;
  - integration checks ran on the integration branch;
  - the fidelity review produced a recorded review;
  - the final report lists Charter fidelity;
  - `/superagent:status` showed only a two-line healthy state during the run;
  - the user was asked nothing except the approval and any genuine blocked question.
- [ ] **Step 3:** Repeat on an existing repository with a small change: *"Add a /health endpoint and show the backend status in the footer"*. Confirm the stack discovery and the absence of a scaffold wave. During the run, close and reopen the session, then use `/superagent:resume` to confirm resume works.
- [ ] **Step 4:** For every defect found, add a failing test (CLI, guard, or prompt-content), fix it, and run `node --test test/`. Expected: all pass.
- [ ] **Step 5:** Commit: `docs: README and end-to-end verification`.
