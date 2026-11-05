# superagent

A Claude Code plugin that builds one idea with several agents at once. You give it an idea. It proposes a split on one screen: your idea, frozen word for word as the **Charter**, plus a stack (for a new project), contracts, and tickets grouped into waves. Once you approve, it runs worker subagents in parallel, each in its own git worktree and limited to the paths its ticket owns. It then merges their branches into an integration branch, runs the project's checks there, and has an independent reviewer compare the result with the Charter. It stays quiet while it works and interrupts you only to approve the split, to ask a question only you can answer, to report a failure it cannot recover from, and to give the final report. Hooks, not prompts, enforce the boundaries.

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

It needs Node.js (tested with Node 26) and git. The target project must be a git repository; the plugin offers to create one in an empty folder (see Known limitations).

## Commands

| Command | What it does |
|---|---|
| `/superagent:start <idea or spec path>` | Proposes the split, waits for your approval, then runs the waves, merge, verification and fidelity review, and ends with a final report. |
| `/superagent:status` | Two lines when all is well: what needs you (or "Nothing needs you."), then the run's phase, wave and ticket counts. |
| `/superagent:resume` | Continues the active run from its phase on disk, after a new session or a context compaction. |
| `/superagent:abort` | Ends the active run. Its branches and worktrees are left for you. |

Run state is kept in `.superagent/` in your project. It is added to `.git/info/exclude`, as is `.claude/worktrees/`. The result is left on the branch `superagent/<run-id>`. The plugin never merges it into your base branch.

## Configuration

`.superagent/config.json` is optional. Write it yourself: the hooks treat it as run state, so Claude cannot edit it once `.superagent/` exists.

```json
{ "parallelism": 4, "production_markers": ["prod-db.example.com"], "worker_model": "inherit" }
```

- `parallelism`: the most workers that run at once, from 1 to 8 (default 4). A plan can also set its own.
- `production_markers`: strings such as hosts, database URLs or deploy scripts. Any Bash command containing one is blocked during a run, unless the Charter allows `production`.
- `worker_model`: the model for workers. The default, `inherit`, uses the session's model.

## Outward actions

During a run, a Bash hook blocks `git push`, deploy commands (fly, railway, kubectl, helm, terraform, pulumi, serverless, firebase, heroku, `vercel --prod`, `docker push` and similar), publish commands (`npm publish`, `cargo publish`, `gh release create`, `eas submit` and similar), and commands that contain a production marker. It blocks them even with permission prompts bypassed. A run may perform one of these only if the approved Charter's `allowed_actions` lists it (`push`, `deploy`, `publish` or `production`). The orchestrator adds an action there only when your idea asks for it, and it appears in the proposal you approve. To allow one mid-run, ask for it. The orchestrator writes a Charter revision (`superagent revise-charter` with a JSON file can change the idea, the scope lines and the allowed actions), shows it to you with the tickets it would put out of scope, and the new actions apply only once you approve it.

The other enforced rules are these. They hold from the first approval until the run is done or aborted, including while a revised Charter waits for your approval. Workers may edit only their ticket's owned paths, inside their own worktree, and never the main checkout. The main checkout is read-only while a wave runs or a revision waits for approval. Run state (`.superagent/runs/` and `.superagent/active`) changes only through the CLI, `.superagent/config.json` only by your hand, and `git clean -x` and `git stash -a` are blocked because they would remove them. Before a merge, each branch's diff is checked against its owned paths.

## Known limitations

- **Bash file writes are caught at merge, not at write time, and only on the worker's branch.** The write hook covers Edit and Write. Files a worker changes in its own worktree through Bash, generators or package managers (including `python -c`, `perl -e` and `node -e`) are caught by the pre-merge diff check, which fails the ticket and turns it into a handback. The diff check looks only at the worker's branch: a Bash write into the main checkout, or a commit made there with `git -C <root> commit`, does not show up in it. Bash is not sandboxed; the worker's instructions forbid leaving its worktree, and orchestrator commands refuse to run inside one.
- **Integration tests run only after the final wave.** Workers run only parallel-safe checks (unit tests, typecheck, lint, builds). E2E tests, real databases and running services are checked once, on the integration branch.
- **The approval and question screens must be checked by hand on first use.** The end-to-end runs were headless, with approval granted in the prompt. See `docs/e2e-checklist.md`.
- **The outward-action guard matches text.** Quoted text is matched too, so `git commit -m "never git push"` is blocked. Commands behind `timeout` or behind uncommon `yarn` forms may not be recognised.
- **Read-only redirects can be denied by mistake.** A redirect that only names a path inside `.superagent/runs/` is denied, even when nothing is written there.
- **The guard is keyed on the session's working directory.** A session started outside the project's repository is not guarded. Only `git clean -x` and `git stash -a/--all` are recognised as commands that delete ignored files; scripts that delete them some other way are not.
- **A brand-new folder needs one restart.** Claude Code checks for a git repository only at session start. If the plugin creates the repository, it proposes the split and takes your approval, then asks you to restart Claude Code in the folder and run `/superagent:resume` to launch the workers.
- Live subagents do not survive a new session. On resume, a `blocked` or lost worker is replaced by a fresh one. It gets a new worktree, merges the earlier attempt's branch into it, and continues from the ticket's last report.
