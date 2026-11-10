# superagent

A Claude Code plugin that builds one idea with several agents at once. You give it an idea. It proposes a split on one screen: your idea, frozen word for word as the **Charter**, plus a stack (for a new project), contracts, and tickets grouped into waves, with a preflight check for coupling and missing contracts. Once you approve, it runs worker subagents in parallel, each in its own git worktree and limited to the paths its ticket owns. From then on a small scheduler command, `superagent next`, decides the one next action: launch, merge, ask, verify, review or advance. It merges their branches into an integration branch, audits the main checkout, runs the project's checks there, and has an independent reviewer compare the result with the Charter in an isolated review worktree. It stays quiet while it works and interrupts you only to approve the split, to ask a question only you can answer, to report a failure it cannot recover from, and to give the final report. Hooks, not prompts, enforce the boundaries.

The ideas come from [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype) (DeepSeek Harness): the original request is the source of truth, each worker gets a fixed mandate, reports are structured, there is one question at a time, the host enforces permissions, and everything the model sees is logged.

## Install

From a local checkout, through a local marketplace (inside Claude Code):

```
/plugin marketplace add /path/to/claude-superagent
/plugin install superagent@superagent-local
```

The same from a shell: `claude plugin marketplace add /path/to/claude-superagent`, then `claude plugin install superagent@superagent-local`.

To try it without installing, load it for one session:

```
claude --plugin-dir /path/to/claude-superagent
```

It needs Node.js 22 or newer (tested with Node 26) and git. The target project must be a git repository; the plugin offers to create one in an empty folder (see Known limitations).

## Commands

| Command | What it does |
|---|---|
| `/superagent:start <idea or spec path>` | Proposes the split, waits for your approval, then runs the waves, merge, verification and fidelity review, and ends with a final report. |
| `/superagent:status` | Two lines when all is well: what needs you (or "Nothing needs you."), then the run's phase, wave and ticket counts. |
| `/superagent:resume` | Continues the active run from its phase on disk, after a new session or a context compaction. It reads `superagent context` first. |
| `/superagent:abort` | Ends the active run. Its branches and worktrees are left for you. |

Run state is kept in `.superagent/` in your project. It is added to `.git/info/exclude`, as is `.claude/worktrees/`. The result is left on the branch `superagent/<run-id>`. The plugin never merges it into your base branch.

## The CLI

The agents and the orchestrator use a small Node CLI, `superagent <command>`, from the main checkout. You can run every command yourself to inspect a run; the ones marked read-only never change state.

| Group | Commands |
|---|---|
| Run | `init`, `propose`, `proposal`, `approve`, `revise-charter`, `show`, `status`, `abort`, `finish` |
| Waves and tickets | `next`, `next-wave`, `start-ticket`, `set-agent`, `mark-failed`, `claim`, `brief`, `report`, `answer`, `add-ticket`, `retarget`, `drop-ticket`, `check-diff`, `merge`, `merge-continue`, `merge-abort` |
| Trust, review and metrics | `doctor`, `audit`, `stats`, `verify-result`, `review`, `review-setup`, `review-close`, `ruling`, `context` |

Exit codes: 0 ok; 1 usage or validation; 2 state (no or unreadable run); 3 refusal (wrong phase or state) or conflict, with a message that says what to do.

### `superagent next`: frontier scheduling

`next` is read-only and prints exactly one action for the orchestrator: `launch T3 T4`, `merge T2`, `merge-continue T2`, `ask T5`, `stuck T2`, `verify`, `review`, `advance`, `wait` or `none`. The orchestrator does that one action, then calls `next` again. A ticket can declare `depends_on` other tickets; it launches once those are merged, so independent work starts as soon as it is ready instead of waiting for a whole wave. Tickets without `depends_on` keep the wave barrier: every lower wave must merge first. `next` never launches two tickets whose owned paths overlap, and it refuses while an overlapping ticket is running or waiting to merge. If a dependency fails or is dropped, `next` prints `stuck <T>`: repoint the ticket with `superagent retarget <T> --depends-on <replacement>` (or clear it with `none`; a replacement in a later wave moves the ticket to that wave), or drop it with `superagent drop-ticket <T> --reason <why>`. `--json` prints `{ action, tickets, detail }`.

### Plan preflight

Before the proposal is shown to you, a read-only `plan-critic` agent reads the plan file and the repository and returns risks as JSON: coupling between same-wave tickets, a shared file a work ticket owns, a decision no contracts ticket writes down, and ambiguous scopes. If it finds a real risk, the orchestrator fixes the plan and reruns `propose` (at most twice) before you see it. Style notes are filtered out.

### Reviewer isolation

During review the fidelity reviewer works in a detached worktree of the integration branch, created by `superagent review-setup` and removed by `superagent review-close`. Untracked files are not copied into a worktree, so the review worktree contains no `.superagent/` state. Hooks enforce the isolation by agent type: a `Read|Grep|Glob` guard allows the reviewer to open only paths inside that review worktree, and a Bash guard denies any command that mentions the main checkout path, `.superagent/` (other than `.superagent/drafts`) or `superagent show --json` (including the `node .../superagent.mjs` form). The reviewer gets the run id and worktree path, judges the diff against the Charter, and records `met` items (each with file-level evidence) alongside `unmet`, `extras` and `contradictions`. `superagent review` checks that every in-scope Charter item is assessed in exactly one of `met` or `unmet`, so an empty or partial review is rejected rather than treated as a pass. The orchestrator records the JSON from the main checkout with `superagent review --file <absolute path>`.

### Integrity checks and run metrics

- `superagent doctor` runs environment and guard self-checks: Node version, plugin layout and hook registration, that the file and Bash guards deny what they should, that the main root resolves, and that an active run loads. Exit 0 when every check passes, 1 otherwise.
- `superagent audit` verifies the main checkout against the approved run: the base branch tip still equals the recorded `base_sha`; every first-parent commit on the integration branch is a merge this run recorded (an unrecorded commit made directly in the main checkout is named and fails the audit); the working tree is clean; the main checkout is on the integration branch (warning only); and the guard self-test passes. Exit 3 on an integrity violation and 2 on a state error. It detects an integrity violation after the fact; it does not prevent it.
- `superagent stats [--json]` derives run metrics from `run.json`, tickets, reports and the event log: duration, ticket counts by status and origin, attempts, blocked reports, merge conflicts, merges, verifications, reviews and fix waves used.
- `superagent context` prints a compact resume brief: run, phase, wave, branch, ticket counts, any blocked question, the latest fidelity counts and the `next` action.
- `superagent ruling --text <text> [--ticket <T>]` records an orchestrator decision (a shared-file conflict resolution, an accepted handback, an aborted merge) in the run's event log, so the reasoning survives a resume.

## Configuration

`.superagent/config.json` is optional. Write it yourself: the hooks treat it as run state, so Claude cannot edit it once `.superagent/` exists.

```json
{ "parallelism": 4, "production_markers": ["prod-db.example.com"], "worker_model": "inherit" }
```

- `parallelism`: the most workers that run at once, from 1 to 8 (default 4). A plan can also set its own.
- `production_markers`: strings such as hosts, database URLs or deploy scripts. Any Bash command containing one is blocked during a run, unless the Charter allows `production`.
- `worker_model`: the model for workers. The default, `inherit`, uses the session's model. A plan ticket can set its own `model`, which takes precedence for that ticket's worker only.

## Plan fields

The plan JSON in `skills/orchestrate/proposal-format.md` is what `superagent propose` validates. On top of the charter, project, contracts and tickets, it supports:

- `shared_files`: manifests, lockfiles, root config, route registries and CI files that many tickets would touch. Every entry must be owned by a scaffold or contracts ticket, and no work or fix ticket may own one.
- per-ticket `depends_on`: ticket ids that must be merged before this ticket launches. Duplicates, self-references, cycles and edges from a later wave are rejected.
- per-ticket `model`: the worker model for that ticket, overriding `worker_model`.

## Outward actions

During a run, a Bash hook blocks `git push`, deploy commands (fly, railway, kubectl, helm, terraform, pulumi, serverless, firebase, heroku, `vercel --prod`, `docker push` and similar), publish commands (`npm publish`, `cargo publish`, `gh release create`, `eas submit` and similar), and commands that contain a production marker. It blocks them even with permission prompts bypassed. A run may perform one of these only if the approved Charter's `allowed_actions` lists it (`push`, `deploy`, `publish` or `production`). The orchestrator adds an action there only when your idea asks for it, and it appears in the proposal you approve. To allow one mid-run, ask for it. The orchestrator writes a Charter revision (`superagent revise-charter` with a JSON file can change the idea, the scope lines and the allowed actions), shows it to you with the tickets it would put out of scope, and the new actions apply only once you approve it.

The other enforced rules are these. They hold from the first approval until the run is done or aborted, including while a revised Charter waits for your approval. Workers may edit only their ticket's owned paths, inside their own worktree, and never the main checkout. The main checkout is read-only while a wave runs or a revision waits for approval. Run state (`.superagent/runs/` and `.superagent/active`) changes only through the CLI, `.superagent/config.json` only by your hand, and `git clean -x` and `git stash -a` are blocked because they would remove them. Before a merge, each branch's diff is checked against its owned paths.

## Eval harness

`evals/` answers "faster at equal accuracy". It compares three ways of building the same bookmarks fixture: `single` (one direct agent), `waves` (wave barriers), and `frontier` (`superagent next`). The fixture is an explicit Node.js HTTP contract — start with `npm start` or `node server.js`, listen on `process.env.PORT`, store durably (using `BOOKMARKS_DB` when set), `POST /api/bookmarks {url,title}`, and `GET /api/bookmarks` returning both newest first — and the harness judges every arm with its own test, `node evals/accept.mjs <repo>`, not with the arm's tests: it starts the app on a free port with a temp database, posts two bookmarks, checks the list and stops it. `node evals/run.mjs` is a dry run that prints each arm's exact `claude -p ... --plugin-dir <repo>` command, its prompt and its acceptance command; `--live` executes them, with `--runs N` repeating every arm in a fresh temporary git repository. Every prompt pre-approves the proposal as shown and tells the orchestrator to answer worker questions with the most conservative option (headless runs have no AskUserQuestion). Live runs default to an isolated throwaway `CLAUDE_CONFIG_DIR` and need `ANTHROPIC_API_KEY` (they stop with a message naming the key or `--user-config` if it is missing); `--user-config` opts into your real Claude Code config and warns once that global plugins, hooks and `CLAUDE.md` apply, and `--isolated-config` is an alias for the default. Results are per-arm wall-clock min/median/max, exit codes, acceptance pass rate and, for the superagent arms, `metricsForRun` means including `human_interventions`; they are printed and written under the git-ignored `evals/results/`. Live mode is unverified in this checkout; use at least 3 repetitions per arm. See `evals/README.md`.

## Known limitations

- **Bash is still not sandboxed.** The write hook covers Edit and Write. Files a worker changes in its own worktree through Bash, generators or package managers (including `python -c`, `perl -e` and `node -e`) are caught by the pre-merge diff check, which fails the ticket and turns it into a handback. The diff check looks only at the worker's branch: a Bash write into the main checkout, or a commit made there with `git -C <root> commit`, does not show up in it. `superagent audit` checks the base branch and the integration branch's first-parent commits after the fact, and it detects such a change without preventing it. The worker's instructions forbid leaving its worktree, and orchestrator commands refuse to run inside one.
- **Reviewer isolation is layered, not absolute.** The reviewer works in a review worktree with no `.superagent/`. Hooks, not prompts, enforce its boundaries: Read, Grep and Glob may open only paths inside that worktree (symlinks and `..` are resolved first), and Bash is denied commands that mention the main checkout path, `.superagent/` (other than `.superagent/drafts`) or `superagent show --json`. The prompt still forbids asking for the tickets, the plan or the worker reports. Bash matching is textual: a crafted spelling of a path could evade the pattern, which is why this is a guard and not a sandbox.
- **The plugin is coupled to Claude Code.** Parallel workers use Claude Code subagents with worktree isolation, and the orchestrator loads `ListAgents`, `SendMessage` and `AskUserQuestion` as deferred tools. Other hosts are unsupported, and macOS is the only tested platform.
- **Integration tests run only after the final wave.** Workers run only parallel-safe checks (unit tests, typecheck, lint, builds). E2E tests, real databases and running services are checked once, on the integration branch.
- **The approval and question screens must be checked by hand on first use.** The end-to-end runs were headless, with approval granted in the prompt. See `docs/e2e-checklist.md`.
- **The outward-action guard matches text.** Quoted text is matched too, so `git commit -m "never git push"` is blocked. Commands behind `timeout` or behind uncommon `yarn` forms may not be recognised.
- **Read-only redirects can be denied by mistake.** A redirect that only names a path inside `.superagent/runs/` is denied, even when nothing is written there.
- **The guard is keyed on the session's working directory.** A session started outside the project's repository is not guarded. Only `git clean -x` and `git stash -a/--all` are recognised as commands that delete ignored files; scripts that delete them some other way are not.
- **A brand-new folder needs one restart.** Claude Code checks for a git repository only at session start. If the plugin creates the repository, it proposes the split and takes your approval, then asks you to restart Claude Code in the folder and run `/superagent:resume` to launch the workers.
- Live subagents do not survive a new session. On resume, a `blocked` or lost worker is replaced by a fresh one. It gets a new worktree, merges the earlier attempt's branch into it, and continues from the ticket's last report.
