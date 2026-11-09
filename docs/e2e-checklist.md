# End-to-end verification (Task 9)

Run on 2026-11-06 with Claude Code 2.1.318, headlessly:
`claude -p "<prompt>" --plugin-dir <repo> --dangerously-skip-permissions --model sonnet --output-format stream-json --verbose`,
in throwaway folders. A headless session cannot answer AskUserQuestion, so approval was granted in the prompt ("approve the proposal as shown; answer worker questions with the most conservative option"). The user's real Claude Code config was not touched.

Verdicts: ✅ verified, ❌ failed, manual = the user must check this by hand.

## Scenario 1: new project (todo app)

Idea: *"A todo app: Express + SQLite backend with REST endpoints for todos, a React (Vite) frontend listing and adding todos, a migration creating the todos table, and a GitHub Actions workflow running the tests."*
Run `20261106-0205-todo-app`. Session A ran `/superagent:start` in an empty folder (git init, split, approve, then stop for a restart). Session B ran `/superagent:resume` and finished the run.

| # | Check | Verdict | Evidence |
|---|---|---|---|
| 1 | The proposal fits one screen and shows the stack, scaffold wave, contracts wave and at least two parallel tickets | ✅ | `propose` printed 50 lines: `Stack` ("JavaScript (ESM); npm workspaces; Express in server/ with better-sqlite3; React + Vite in web/; Vitest, supertest and Testing Library", plus setup, checks and integration checks), `Wave 0 (scaffold)` T1, `Wave 1 (single)` T2 contracts, `Wave 2 (parallel)` T3+T4, `Wave 3 (parallel)` T5+T6. Scope lines are cut to one line with `…`; the quoted idea line is 210 characters wide. |
| 2 | Nothing is built before approval | ✅ | events: `approved 21:06:01`, first `ticket_started T1 21:06:25`. Session A made no Agent call (tools used: Skill ×2, Bash ×5, Read ×1). |
| 3 | At least two workers ran at the same time | ✅ | events (UTC): `started T3 21:10:03`, `started T4 21:10:03`, `claimed T3 21:10:06`, `claimed T4 21:10:08`, `reported T3 21:10:45`, `reported T4 21:10:50`. Wave 3: `claimed T5/T6 21:11:00`, `reported T6 21:11:37`, `reported T5 21:11:58`. |
| 4a | Each worker edited only its own worktree | ✅ | Every worker Write/Edit `file_path` was under its own `.claude/worktrees/agent-<id>/`, apart from report-file attempts (see defect 2). Each commit touched only its ticket's `owns`, e.g. T3 (`server/migrations/`, `server/src/db.js`, `server/test/db.test.js`), commit `e80435e`: exactly those three paths. All six tickets passed the pre-merge diff check (`merged T1..T6`). |
| 4b | A deliberate out-of-scope write is denied by the hook | ✅ | Dedicated guard session (one `superagent:worker`, ticket owns `src/a.txt`, Charter told it to try the write once): `PreToolUse:Write hook error: Blocked (superagent:worker): NOTOWNED.txt is outside the paths T1 owns src/a.txt. Out-of-scope needs go in your report's handbacks.` |
| 5 | `git push` from a worker is denied | ✅ | Same guard session, a real bare remote configured: `PreToolUse:Bash hook error: Blocked: \`push\` is not in this run's approved Charter. Ask the user; a Charter revision can allow it.` The remote got no new commits. |
| 6 | Every ticket merged with no unexplained conflict | ✅ | `merged T1` … `merged T6`, no `merging` phase; `git log --graph superagent/20261106-0205-todo-app` shows six `Merge branch 'worktree-agent-…'` commits. |
| 7 | Integration checks ran on the integration branch | ✅ | `verify-1.log`: `### npm run test:integration --workspace server` … `Tests 1 passed (1)`; server `Tests 29 passed`, web `Tests 4 passed`; event `verified true`. |
| 8 | The fidelity review produced a recorded review | ✅ | `.superagent/runs/20261106-0205-todo-app/reviews/1.json`: unmet 0, contradictions 0, extras 3 (`GET /health endpoint`; `contracts/ documentation files`; `Server-side PATCH and DELETE (and GET by id)…`). |
| 9 | The final report lists Charter fidelity | ✅ | Final message: "**Charter fidelity:** nothing unmet and no contradictions. The reviewer flagged three extras, which I left in place for you to decide on: …" |
| 10 | `/superagent:status` showed only a two-line healthy state during the run | ✅ | Headless `/superagent:status` mid-run printed exactly: `Nothing needs you.` / `Run 20261106-0205-todo-app · running · wave 3/3 · 2 running · 4 merged · 0 planned`. |
| 11 | The user was asked nothing except the approval and any genuine blocked question | ✅ (headless) | No AskUserQuestion call in either session; no worker reported `blocked`. The orchestrator did end each waiting turn with a one-line progress note; that was fixed afterwards (defect 4). |

## Scenario 2: existing repository, with resume

Repo: the finished todo app, merged to `main`, with its `/health` route removed. Idea: *"Add a /health endpoint and show the backend status in the footer"*. Run `20261106-0216-health-endpoint-and-footer-status`.

| # | Check | Verdict | Evidence |
|---|---|---|---|
| 12 | Stack discovery | ✅ | plan.json `project`: `kind: "existing"`, `stack: "Node ESM; npm workspaces; Express 5 + better-sqlite3 in server/; React 19 + Vite in web/; Vitest"`, `checks: ["npm test --workspaces", "npm run build --workspace web"]`, `integration_checks: ["npm run test:integration --workspace server"]`, all taken from the repo's manifests. |
| 13 | No scaffold wave | ✅ | Proposal: one `Wave 0 (parallel)` with T1 (backend `/health`) and T2 (footer); no scaffold or contracts ticket. |
| 14 | Close and reopen the session mid-run, then `/superagent:resume` | ✅ | Session A was killed 25 s after T2 was claimed (`2 running`, two locked worktrees). Session B: `ToolSearch select:ListAgents,SendMessage` → `ListAgents` → `start-ticket T1 && start-ticket T2` → two fresh workers with `Earlier attempt's branch: worktree-agent-a1dfa1a1881c2f059 …` → events `ticket_started T1#2/T2#2`, `reported T1#2/T2#2`, `merged T1/T2`, `verified true`, review 0/0/0, `finished`. No ticket had two live workers. |

## Defects found and fixed

1. **Worktree isolation fails after `init --git-init`.** Claude Code decides at session start whether the folder is a git repository; the Agent call failed with "Cannot create agent worktree: not in a git repository". Fix: the skill does split and approval, then tells the user to restart and run `/superagent:resume` (commit `322da40`). Verified by scenario 1, sessions A and B.
2. **Workers could not write their report file.** Claude Code confines a worktree-isolated agent's Write tool to its worktree ("Edit the worktree copy of this file instead of the shared-checkout path"). Fix: `superagent brief` points a worker at `<worktree>/.superagent/drafts/<run>/`, and the file guard allows that path for its own worktree only (commit `e7e364b`). Found by the guard session, landed while scenario 1 was in wave 0: T1 had already worked around it via `/tmp`; T2–T6 and both scenario 2 workers used the new path.
3. `/superagent:start` expected `status` to exit 2 for "no active run", but it exits 1 in a folder that is not a git repository yet (commit `98ffc03`).
4. The orchestrator ended each waiting turn with a progress line (commit `0b311b9`). This prompt change was not re-run.

## Left for the user to check by hand (manual)

| Check | Verdict |
|---|---|
| The real approval screen: the proposal shown in a code block and the AskUserQuestion approve/change prompt, in an interactive session | manual |
| The interactive question flow: a `blocked` worker's question asked with AskUserQuestion, the answer recorded, the same worker resumed with SendMessage | manual |
| `/plugin marketplace add /path/to/claude-superagent` and `/plugin install superagent@superagent-local` in the interactive UI, then a normal session using the installed copy (commands, hooks and `bin/` on PATH coming from the plugin cache) | manual |

The CLI install path was re-checked in an isolated `CLAUDE_CONFIG_DIR`: `claude plugin marketplace add` → "Successfully added marketplace: superagent-local"; `claude plugin install superagent@superagent-local` → "Successfully installed plugin"; the cache copy has an executable `bin/superagent` and `hooks/hooks.json`; `claude plugin validate .` → "Validation passed".

## v0.2 additions (not yet verified end-to-end)

The runs above were made on v0.1. The v0.2 prompt and interface changes have unit-test coverage but have not been re-run headlessly. Re-run one scenario (ideally scenario 2, an existing repo) and check:

| # | Check | Verdict |
|---|---|---|
| 15 | The plan preflight launches `superagent:plan-critic`, and the proposal is only shown after its risks are resolved or judged non-real | not run |
| 16 | The wave loop follows `superagent next` actions: `launch` → `merge` → `advance` → `verify` → `review`, with no launches or merges `next` did not print | not run |
| 17 | `superagent audit` runs before the verification checks and passes on a clean run | not run |
| 18 | The reviewer is launched with the `superagent review-setup` path, its `review.json` is recorded with `review --file`, and `review-close` removes the worktree | not run |
| 19 | The review JSON covers every in-scope Charter item in `met` or `unmet`, with file-level evidence | not run |
| 20 | Per-ticket `model`, `shared_files` and `depends_on` appear in the proposal and change scheduling as intended | not run |
| 21 | Resume after compaction starts with `superagent context` and reconciles ListAgents with `running` tickets; orchestrator decisions are recorded with `superagent ruling` | not run |
| 22 | The fast path offers to skip a run for a one-file idea | not run |
| 23 | `evals/run.mjs --live` produces a metrics summary for all three arms (dry run is covered by `test/evals.test.mjs`) | not run |

## v0.2.1 fixes (unit-verified; live run not repeated)

The seven findings from the v0.2 adversarial review were fixed and covered by tests. The v0.1 end-to-end
sessions above predate these changes, so a fresh headless/manual scenario is still worth running.

| # | Check | Verdict |
|---|---|---|
| 24 | A failed `depends_on` reports `stuck`, and `retarget` / `drop-ticket` unstick the run | unit-tested |
| 25 | `audit` names an unrecorded commit made directly on the integration branch and fails; a dirty tree fails | unit-tested |
| 26 | A review that omits an in-scope Charter item is rejected (coverage, not just shape) | unit-tested |
| 27 | Two frontier tickets that own the same paths are never scheduled together; `start-ticket` refuses the second | unit-tested |
| 28 | Fix/fidelity waves use `max(wave) + 1`, and `add-ticket` suggests the first usable wave | unit-tested |
| 29 | Evals: dry run prints pre-approval, auth pre-check and an independent acceptance command per arm; live mode not yet run | dry-run tested, live not run |
| 30 | The reviewer's Read/Grep/Glob tools are confined to the review worktree, and `show --json` is denied by the Bash guard | unit-tested |
