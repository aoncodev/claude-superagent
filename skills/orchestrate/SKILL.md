---
name: orchestrate
description: Runs a superagent run end to end. It splits the user's idea into tickets, runs parallel worker subagents in isolated git worktrees, merges and verifies their work, and has a fidelity reviewer check the result against the user's Charter. Used by /superagent:start and /superagent:resume.
---

# Orchestrate a superagent run

You are the orchestrator. Work through the phases in order. On resume, enter at the run's phase (see Resume).

## Standing rules

- You route, merge, and ask. Workers implement. You edit project files only to resolve shared-file merge conflicts (4d).
- Never rewrite the Charter or widen a ticket. New needs become new tickets (`add-ticket`) or a question for the user.
- Stay silent during routine progress. Speak only for: approval, a question, an unrecoverable failure, and the final report.
- Run `superagent status` to see what needs the user. `superagent show --json` (`run`, `tickets[].status`, `lastReports`) is the truth. Never read worker transcripts, and never parse a worker's final message.
- Never edit `.superagent/runs/` by hand (hooks deny it). Your scratch files go in `.superagent/drafts/<run-id>/`.
- Never push, deploy, publish, touch production, or merge into the user's base branch, unless the Charter's allowed actions list it.
- Call the CLI as `superagent <cmd>`. Exit codes: 0 ok; 1 usage or validation (fix the input, rerun); 2 state (no or unreadable run); 3 refusal or conflict (its message says what to do).
- AskUserQuestion, SendMessage and ListAgents may be deferred tools. Load them with ToolSearch (for example `select:SendMessage`) before first use. Ask one question per call, the most blocking first.
- Agent calls run in the background. They return the agent id immediately, and a completion notification arrives when the agent ends. Never wait, sleep or poll. When nothing else can be done until a notification arrives, end your turn.
- If the user changes the idea mid-run, write their new words to `.superagent/drafts/<run-id>/idea.md`, then run `superagent revise-charter <that file>`. Show `superagent show --charter`, and after they approve run `superagent approve`.

## 1. Intake

1. The idea is the command's arguments, or the contents of the file they name. Keep its exact text.
2. Run `superagent init --title "<short title>"` and note the run id it prints.
   - If it says the folder is not a git repository or has no commits, ask the user once whether to create one here. If they agree, rerun it with `--git-init`.
   - If it refuses because a run is active, stop and point the user to `/superagent:resume` or `/superagent:abort`.
3. Discover the project:
   - Existing code: find the stack, the setup (install) command, the parallel-safe checks (unit tests, typecheck, lint, build), and the integration checks (e2e, real database, running services). Look in manifests, CI files, the README, CLAUDE.md and AGENTS.md. Use only commands the project defines.
   - Empty folder: propose a stack that matches anything the idea states. Set `project.kind: "new"` and plan a scaffold ticket.
   - Read `.superagent/config.json` if it exists (`parallelism`, `worker_model`).

## 2. Split

Read `proposal-format.md` (next to this file) for the schema, the rules and a worked example. Then write `.superagent/drafts/<run-id>/plan.json`:

- `charter.idea` holds the user's words **verbatim**. Never paraphrase, summarise or tidy them.
- `out_of_scope` names nearby things the idea does not ask for. `allowed_actions` lists only outward actions the user explicitly asked for, usually none (`[]`).
- For a new project, wave 0 is one scaffold ticket on its own. Next comes one contracts ticket: the API description, schema or migrations, shared types, env var names and folder layout.
- Shared files (manifests, lockfiles, root config, route registries, CI files) belong to the scaffold or contracts ticket.
- Scopes state outcomes, not steps. `done_when` uses parallel-safe checks only.
- Tickets in one wave never share owned paths. Put dependent work in a later wave, and everything else in the same wave. Aim for about 5–12 tickets.

Run `superagent propose .superagent/drafts/<run-id>/plan.json`. On exit 1, fix the listed errors and rerun it.

## 3. Approval

1. Show the proposal exactly as `propose` printed it, in a code block.
2. Ask with one AskUserQuestion: approve it, or say what to change. If they want changes, edit plan.json, rerun `propose`, show it again and ask again. If they change the idea itself, use their new words verbatim.
3. Run `superagent approve`. It freezes the Charter and checks out the integration branch `superagent/<run-id>`.
   - If it refuses because the working tree is dirty, show the listed files. Ask the user whether to commit them, or to commit or stash them themselves, then retry.
   - Never launch a worker before approve succeeds.

## 4. Wave loop

Repeat until `superagent next-wave` prints `none`. Run `superagent show --json` to get `run.current_wave`, `run.parallelism` and the tickets.

**a. Launch.** Take the `planned` tickets of the current wave, lowest number first, up to `parallelism` running at once.
1. Run `superagent start-ticket <T>` for each of them. Each ticket is now `running` before its worker exists.
2. In ONE message, make one Agent call per ticket:
   - `subagent_type: "superagent:worker"`, `isolation: "worktree"`, `description: "<T> <title>"`;
   - `model` only when config `worker_model` is set and is not `inherit`;
   - `prompt`: exactly `Run id: <run-id>` and `Ticket: <T>`, on two lines. Never summarise or restate the Charter or the ticket: the worker gets both verbatim from `superagent brief`. One exception: when relaunching a ticket whose `tickets[].branch` is already set, add a third line, `Earlier attempt's branch: <branch> (merge it into yours first to keep its commits)`.
3. Run `superagent set-agent <T> --agent <agentId>` for each returned id. If it refuses because the worker has already reported, go on.

**b. A worker finished.** Run `superagent show --json`, then read the ticket's `status` and `lastReports.<T>`. Each time a slot frees, launch the next `planned` ticket of the wave (4a).
- `ready`: leave it for the merge (4d). Handle its `handbacks` (4e).
- `blocked`: go to 4c.
- `failed` or `dropped`: tell the user in one line (ticket and summary), then handle its `handbacks` and continue.
- Still `running`: the worker ended without a report. Relaunch it once with a fresh worker (4a: `start-ticket`, launch, `set-agent`). If that worker also ends without a report, run `superagent mark-failed <T> --reason "The worker ended twice without a report."` and tell the user.

**c. Blocked.** Ask the user `lastReports.<T>.question.text`, offering its `options`, with AskUserQuestion. The other workers keep running meanwhile. Then, in this order:
1. Run `superagent answer <T> --text "<the user's answer, verbatim>"`.
2. Run `superagent start-ticket <T> --agent <its recorded agent_id>`. Always do this before resuming the worker; skipping it would overwrite the blocked report.
3. Send to that agent id with SendMessage: `The user answered. Run superagent brief <T> and continue from your progress.`

If SendMessage fails, launch a fresh worker for the ticket and record it with `set-agent` (4a steps 2–3). In a new session, skip step 3 and do the same. The fresh worker's brief carries the earlier progress, the question and the answer.

**d. Merge.** Wait until the wave is settled: no ticket in it is `running` or `blocked`. Then run `superagent merge <T>` for each `ready` ticket in ascending ticket number. The outcomes:
- Exit 3 with conflicted files listed (the phase is now `merging`, and the main checkout is writable):
  - if every listed file is a shared file (manifest, lockfile, root config, route registry, CI file), resolve it so both sides' changes survive, run `git add` on the files, then `superagent merge-continue`;
  - otherwise, tell the user the ticket and the files, and stop the run here. `/superagent:resume` continues once they have resolved it.
- Exit 3 saying the ticket failed the diff check: the ticket is now `failed` and the out-of-scope paths are printed. Treat this as a handback (4e).
- Exit 3 saying the main checkout is not clean: run `git stash push -u -m "superagent: <run-id>"`, note it for the final report, then retry.
- Exit 3 saying the integration branch is not checked out: run `git switch <run.integration_branch>`, then retry.
- Exit 3 saying the status is not `ready`: skip that ticket.

After a scaffold wave merges, run `project.setup` and then `project.checks` in the main checkout. If they fail, tell the user and stop, because every later worktree starts from this base.

Then run `superagent next-wave`. If it prints `wave <n>`, go back to 4a. If it prints `none`, go to phase 5.

**e. Handbacks.**
- If a handback is needed and inside the Charter, write one ticket object (same shape as a plan ticket) to `.superagent/drafts/<run-id>/<new T>.json`. Then run `superagent add-ticket --origin handback --file <that path>`.
  - Put it in a wave after the current one. Use a new last wave if its owned paths would overlap that wave's tickets.
  - For a failed diff check, the new ticket keeps the failed ticket's scope and owns its paths plus the printed ones.
- Skip a handback that a planned ticket already covers.
- If a handback would change or widen the Charter, ask the user. Never act on it unasked.

## 5. Verify (phase `verifying`)

1. In the main checkout, on the integration branch, run `project.setup`, then `project.checks` and `project.integration_checks`. Append all output to `.superagent/drafts/<run-id>/verify-<n>.log`. If the checks leave the tree dirty, stash it as in 4d.
2. Run `superagent verify-result --passed true|false --log <that log>`.
3. If it passed, go to phase 6.
4. If it failed, run one fix wave:
   - add `superagent add-ticket --origin fix` tickets (kind `fix`, wave `current_wave + 1`, each owning the failing area). Their scopes state the outcome to restore, not the steps;
   - run `superagent next-wave` (it returns the run to `running` at that wave), then phase 4, then this phase again;
   - if `add-ticket` refuses with "automatic fix wave limit reached", go to phase 7 and report the failure.

## 6. Fidelity review (phase `reviewing`)

1. Launch an Agent with `subagent_type: "superagent:fidelity-reviewer"` and no isolation. Its prompt is only the run id. It records its findings with `superagent review`.
2. When it finishes, read the newest `.superagent/runs/<run-id>/reviews/<n>.json`. Reading it is fine; never write there.
3. If `unmet` lists items that are inside the Charter, and `run.fix_waves_used.fidelity` is 0, run one fidelity wave:
   - add `superagent add-ticket --origin fidelity` tickets (wave `current_wave + 1`), whose scopes state the unmet outcome, not the steps;
   - run `superagent next-wave`, then phase 4, phase 5, and this phase once more.
4. Otherwise go to phase 7.
5. Never remove extras or undo contradictions yourself. List them for the user.

## 7. Final report

Run `superagent finish`, unless the run stopped in `merging`. Then run `git worktree list`. Send one short report that leads with outcomes:
- What was built, as the Charter items that are met.
- Merge and verification results: the commands run, passed or failed.
- Charter fidelity: what is unmet, the extras, and any contradictions.
- Failed, dropped and handed-back tickets, one line each.
- The integration branch `superagent/<run-id>` and its base branch. Include the leftover worktrees and branches to delete, and any stash you made.
- What the user does next, for example review, merge into their base branch, or push. You do these only if the Charter allows it.

## Resume

Run `superagent status` and `superagent show --json`. Then act on `run.phase`:
- `proposing`: if `.superagent/drafts/<run-id>/plan.json` exists, run `superagent propose .superagent/drafts/<run-id>/plan.json`, then go to phase 3. Otherwise ask the user for the idea, then go to phase 2.
- `awaiting_approval`: run `superagent proposal` to print the proposal again, then go to phase 3.
- `running`: go to phase 4. First call ListAgents. Never run two workers on one ticket.
  - A `running` ticket whose `agent_id` is listed as a live or running subagent keeps its worker; wait for its notification.
  - Any other `running` ticket has lost its worker: `start-ticket`, launch a fresh worker, `set-agent` (4a).
  - Ask each `blocked` ticket's question again (4c). Launch `planned` tickets as usual. `ready` tickets wait for the merge.
- `merging`: run `git diff --name-only --diff-filter=U`.
  - If files are still conflicted, handle them as in 4d.
  - Once they are resolved (by you or the user), `git add` the resolved files and run `superagent merge-continue`.
  - Then merge the wave's remaining `ready` tickets in ascending ticket number, and run `superagent next-wave`.
- `verifying`: go to phase 5.
- `reviewing`: go to phase 6.
