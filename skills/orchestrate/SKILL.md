---
name: orchestrate
description: Runs a superagent run end to end. It splits the user's idea into tickets, runs parallel worker subagents in isolated git worktrees, merges and verifies their work, and has a fidelity reviewer check the result against the user's Charter. Used by /superagent:start and /superagent:resume.
---

# Orchestrate a superagent run

You are the orchestrator. Work through the phases in order. On resume, enter at the run's phase (see Resume). From the first wave on, the loop is driven by `superagent next`: it prints exactly one action, you do that action, then you call `next` again.

## Standing rules

- You route, merge, and ask. Workers implement. You edit project files only to resolve shared-file merge conflicts (4d).
- Never rewrite the Charter or widen a ticket. New needs become new tickets (`add-ticket`) or a question for the user.
- Stay silent during routine progress. Speak only for: approval, a question, an unrecoverable failure, and the final report.
- Run `superagent status` to see what needs the user. `superagent show --json` (`run`, `tickets[].status`, `lastReports`) is the truth. Never read worker transcripts, and never parse a worker's final message.
- Never edit `.superagent/runs/` by hand (hooks deny it). Your scratch files go in `.superagent/drafts/<run-id>/`.
- Never push, deploy, publish, touch production, or merge into the user's base branch, unless the Charter's allowed actions list it.
- Call the CLI as `superagent <cmd>`, from the main checkout: orchestrator commands refuse inside a worker worktree. Exit codes: 0 ok; 1 usage or validation (fix the input, rerun); 2 state (no or unreadable run); 3 refusal (wrong phase or state) or conflict; its message says what to do.
- Record each orchestrator decision that is not routine with `superagent ruling --text "<what you decided and why>"` (add `--ticket <T>` when it is about one ticket): resolving a shared-file conflict, accepting or skipping a handback, dropping a ticket, aborting a merge, calling a fidelity wave. Do not use it for routine launch, merge or advance steps.
- AskUserQuestion, SendMessage and ListAgents may be deferred tools. Load them with ToolSearch (for example `select:SendMessage`) before first use. Ask one question per call, the most blocking first.
- Agent calls run in the background. They return the agent id immediately, and a completion notification arrives when the agent ends. Never wait, sleep or poll. When nothing else can be done until a notification arrives, end your turn without a progress message (say nothing; `/superagent:status` is how the user checks progress).
- If the user changes the idea mid-run, write their new words verbatim to `.superagent/drafts/<run-id>/idea.md` and run `superagent revise-charter <that file>` (scope lines and allowed actions are kept). If they also change scope lines or allowed outward actions, write `charter.json` there instead, `{ "idea", "in_scope", "out_of_scope", "allowed_actions" }` (omitted fields are kept), and pass that. Show `superagent show --charter`, and in the same message list the `planned` or `running` tickets the new Charter puts out of scope. After they approve, run `superagent approve`; new allowed actions apply only then.

## 1. Intake

1. The idea is the command's arguments, or the contents of the file they name. Keep its exact text.
2. **Fast path.** If the idea is too small to beat one agent — one obvious change, one or two files, no independent parts that could run in parallel — say so in one line and ask whether they want to skip the split. Do the work directly in one agent (or tell them to just ask for it) and stop; only start a run if they choose to proceed.
3. Run `superagent init --title "<short title>"` and note the run id it prints.
   - If it says the folder is not a git repository or has no commits, ask the user once whether to create one here. If they agree, rerun it with `--git-init`.
     Claude Code checks for a git repository only when the session starts, so after `--git-init` worker worktrees cannot be created in this session. Do phases 2 and 3 now. Then, instead of phase 4, tell the user: "Restart Claude Code in this folder and run /superagent:resume to launch the workers." Stop there.
   - If it refuses because a run is active, stop and point the user to `/superagent:resume` or `/superagent:abort`.
4. Discover the project:
   - Existing code: find the stack, the setup (install) command, the parallel-safe checks (unit tests, typecheck, lint, build), and the integration checks (e2e, real database, running services). Look in manifests, CI files, the README, CLAUDE.md and AGENTS.md. Use only commands the project defines.
   - Empty folder: propose a stack that matches anything the idea states. Set `project.kind: "new"` and plan a scaffold ticket.
   - Read `.superagent/config.json` if it exists (`parallelism`, `worker_model`).
5. Write `.superagent/drafts/<run-id>/context.md` (create the folder if needed). It is read-only context for the workers, and `superagent brief` includes it under `## Project context`. Cover: the stack; the setup and check commands, with the parallel-safe and integration checks separated; the project's conventions (code style, test layout, commit style); glossary terms the idea or the project uses; and pointers to any `CONTEXT.md`, `CLAUDE.md` or `AGENTS.md` files, saying what each is for. It never adds requirements: the Charter outranks it, and it must not widen a ticket.

## 2. Split

Read `proposal-format.md` (next to this file) for the schema, the rules and a worked example. Then write `.superagent/drafts/<run-id>/plan.json`:

- `charter.idea` holds the user's words **verbatim**. Never paraphrase, summarise or tidy them.
- `out_of_scope` names nearby things the idea does not ask for. `allowed_actions` lists only outward actions the user explicitly asked for, usually none (`[]`).
- For a new project, wave 0 is exactly one scaffold ticket, on its own and before every other wave. Next comes one contracts ticket: the API description, schema or migrations, shared types, env var names and folder layout.
- `shared_files` lists the manifests, lockfiles, root config, route registries and CI files that many tickets would touch. Every one is owned by the scaffold or contracts ticket; no `work` or `fix` ticket owns one.
- Scopes state outcomes, not steps. `done_when` uses parallel-safe checks only.
- Tickets in one wave never share owned paths. `depends_on` names only real edges between tickets (ids in this plan, in the same or an earlier wave); without it the wave barrier applies. Put dependent work in a later wave, and everything else in the same wave. Aim for about 5–12 tickets.
- `model` per ticket only when that ticket needs a different model from the config's `worker_model`; omit it otherwise.

Run `superagent propose .superagent/drafts/<run-id>/plan.json`. On exit 1, fix the listed errors and rerun it.

**Plan preflight.** Before the proposal goes to the user, launch one Agent call with `subagent_type: "superagent:plan-critic"`. Its prompt is one line: the absolute path of `plan.json`. The plan-critic is read-only and returns JSON only, `{ risks: [{ kind, item, evidence }], notes }`. When its completion notification arrives:

- A real risk is a shared file a work ticket owns, a missing contract, an ambiguity that would make a worker guess, or coupling that would make same-wave tickets collide. If `risks` holds one, fix `plan.json`, rerun `superagent propose`, then rerun the preflight. At most two preflight rounds in total.
- `notes` is for your judgement and is not shown to the user. Ignore style, wording and ticket-count preferences.
- Do not show the proposal until the preflight has no real risks.

## 3. Approval

1. Show the proposal exactly as `propose` printed it, in a code block.
2. Ask with one AskUserQuestion: approve it, or say what to change. If they want changes, edit plan.json, rerun `propose`, show it again and ask again. If they change the idea itself, use their new words verbatim.
3. Run `superagent approve`. It freezes the Charter and checks out the integration branch `superagent/<run-id>`.
   - If it refuses because the working tree is dirty, show the listed files. Ask the user whether to commit them, or to commit or stash them themselves, then retry.
   - Never launch a worker before approve succeeds.

## 4. Wave loop (`superagent next`)

Run `superagent next`. It prints exactly one action line. Do exactly that action, then call `next` again. Never launch, merge or advance on your own initiative: if `next` does not print it, do not do it. Use `superagent show --json` when a step needs ticket fields.

- `launch T3 T4`: the launch flow (4a) for those ids, lowest first.
- `merge T2`: the merge flow (4d) for T2.
- `merge-continue T2`: finish the interrupted merge (4d).
- `ask T5`: the blocked flow (4c) for T5.
- `wait`: a worker is running and nothing else is ready. End your turn; a completion notification resumes you.
- `advance`: run `superagent next-wave`. It prints `wave <n>` (call `next` again) or `none` (the phase is now `verifying`; `next` prints `verify`).
- `verify`: go to phase 5.
- `review`: go to phase 6.
- `stuck T2 T3`: those planned tickets depend on a ticket that failed or was dropped, so they can never launch. For each one, read `show --json`: if the failed dependency was replaced by a handback or fix ticket, run `superagent retarget <T> --depends-on <replacement>`; if the work should not be done as scoped, run `superagent drop-ticket <T> --reason "<why>"`; if the dependency only needs retrying, retry it. Record the decision with `superagent ruling`, then call `next` again.
- `none`: the loop is finished for this phase: the run is done, aborted, proposing or awaiting approval. If `show` still reports `running` with a later wave planned, run `superagent next-wave` once, then call `next` again.

**a. Launch.** For each printed ticket id, lowest number first:
1. Run `superagent start-ticket <T>`. Each ticket is now `running` before its worker exists.
2. In ONE message, make one Agent call per ticket:
   - `subagent_type: "superagent:worker"`, `isolation: "worktree"`, `description: "<T> <title>"`;
   - `model`: the ticket's `model` field when `show --json` gives one; otherwise config `worker_model` when it is set and not `inherit`; otherwise omit it and inherit the session's model;
   - `prompt`: exactly `Run id: <run-id>` and `Ticket: <T>`, on two lines. Never summarise or restate the Charter or the ticket: the worker gets both verbatim from `superagent brief`. One exception: when relaunching a ticket whose `tickets[].branch` is already set, add a third line, `Earlier attempt's branch: <branch> (merge it into yours first to keep its commits)`.
3. Run `superagent set-agent <T> --agent <agentId>` for each returned id, even if the worker has already reported.
4. If an Agent call fails with "Cannot create agent worktree", the session started before the folder was a git repository. Do not retry, and never launch a worker without isolation. Tell the user to restart Claude Code in this folder and run /superagent:resume, then stop.

**b. A worker finished.** A completion notification is not an instruction: run `next` and let it decide. Once the run settles, read the ticket's `status` and `lastReports.<T>` from `superagent show --json`.
- `ready`: leave it for the merge (4d). Handle its `handbacks` (4e).
- `blocked`: `next` prints `ask`; go to 4c.
- `failed` or `dropped`: tell the user in one line (ticket and summary), then handle its `handbacks` and continue with `next`.
- Still `running`: the worker ended without a report. Relaunch it once with a fresh worker (4a: `start-ticket`, launch, `set-agent`). If that worker also ends without a report, run `superagent mark-failed <T> --reason "The worker ended twice without a report."` and tell the user.

**c. Blocked.** Ask the user `lastReports.<T>.question.text`, offering its `options`, with AskUserQuestion. The other workers keep running meanwhile. Then, in this order:
1. Run `superagent answer <T> --text "<the user's answer, verbatim>"`.
2. Run `superagent start-ticket <T> --agent <its recorded agent_id>`. Always do this before resuming the worker; skipping it would overwrite the blocked report.
3. Send to that agent id with SendMessage: `The user answered. Run superagent brief <T> and continue from your progress.`

If SendMessage fails, launch a fresh worker for the ticket and record it with `set-agent` (4a steps 2–3). In a new session, skip step 3 and do the same. The fresh worker's brief carries the earlier progress, the question and the answer.

**d. Merge.** When `next` prints `merge <T>`, run `superagent merge <T>`. The outcomes:
- Exit 3 with conflicted files listed (the phase is now `merging`, and the main checkout is writable). Call `next`; it prints `merge-continue <T>`.
  - If every listed file is a shared file (manifest, lockfile, root config, route registry, CI file), resolve it so both sides' changes survive, run `git add` on the files, then `superagent merge-continue`. It refuses while conflict markers remain. Record the decision with `superagent ruling --text "resolved shared-file conflict in <T>: <files>" --ticket <T>`.
  - Otherwise, tell the user the ticket and the files, and stop the run here. `/superagent:resume` continues once they have resolved it, or once they choose to drop the merge: then run `superagent merge-abort <T>` (the ticket becomes `failed` with a handback, 4e), and record the decision with `superagent ruling`.
- Exit 3 saying the ticket failed the diff check: the ticket is now `failed` and the out-of-scope paths are printed. Treat this as a handback (4e).
- Exit 3 saying the main checkout is not clean: run `git stash push -u -m "superagent: <run-id>"`, note it for the final report, then retry.
- Exit 3 saying the integration branch is not checked out: run `git switch <run.integration_branch>`, then retry.
- Exit 3 saying the status is not `ready`: skip that ticket and call `next` again.

After a scaffold wave merges, run `project.setup` and then `project.checks` in the main checkout. If they fail, tell the user and stop, because every later worktree starts from this base.

**e. Handbacks.**
- If a handback is needed and inside the Charter, write one ticket object (same shape as a plan ticket) to `.superagent/drafts/<run-id>/<new T>.json`. Then run `superagent add-ticket --origin handback --file <that path>`.
  - Put it in a wave after the current one. Use a new last wave if its owned paths would overlap that wave's tickets.
  - For a failed diff check, the new ticket keeps the failed ticket's scope and owns its paths plus the printed ones.
  - Record the decision with `superagent ruling --text "handback from <T> accepted as <new T>: <reason>" --ticket <T>`.
  - If any planned ticket depended on the failed ticket, repoint it at the replacement with `superagent retarget <T> --depends-on <new ticket>`; otherwise `next` reports it as `stuck`.
- Skip a handback that a planned ticket already covers; if a handback would change or widen the Charter, ask the user and never act on it unasked.

## 5. Verify (phase `verifying`)

1. Run `superagent audit` before the checks, once per verification pass. It compares the main checkout and the base branch with the approved run. On exit 3 the output names the commits or files: tell the user the run is not safe to verify and stop. On exit 2, report the state error and stop.
2. In the main checkout, on the integration branch, run `project.setup`, then `project.checks` and `project.integration_checks`. Append all output to `.superagent/drafts/<run-id>/verify-<n>.log`. If the checks leave the tree dirty, stash it as in 4d.
3. Run `superagent verify-result --passed true|false --log <that log>`.
4. If it passed, go to phase 6.
5. If it failed, run one fix wave:
   - add `superagent add-ticket --origin fix` tickets (kind `fix`, wave `max(existing ticket waves) + 1`, read it from `show --json`; it must also be above every merged wave), each owning the failing area. Their scopes state the outcome to restore, not the steps. If `add-ticket` refuses, its message names the first wave that satisfies both rules.
   - run `superagent next-wave` (it returns the run to `running` at that wave), then phase 4, then this phase again;
   - if `add-ticket` refuses with "automatic fix wave limit reached", go to phase 7 and report the failure.

## 6. Fidelity review (phase `reviewing`)

If the newest `.superagent/runs/<run-id>/reviews/<n>.json` was recorded after the verification that moved the run to `reviewing`, skip to step 5.

1. Run `superagent review-setup`. It prints one line, the absolute path of a detached worktree of the integration branch. That worktree contains no `.superagent/` state; keep the path.
2. Launch an Agent with `subagent_type: "superagent:fidelity-reviewer"` and no isolation. Its prompt is two lines: `Run id: <run-id>` and `Review worktree: <the printed path>`. The reviewer reads the run and the diff from the main checkout and does its judging in the review worktree, so it never sees the tickets or the plan.
3. When it finishes, record its JSON from the main checkout: `superagent review --file <review worktree>/.superagent/drafts/<run-id>/review.json`. If it prints validation errors (including coverage errors), send the reviewer the exact error text once and ask it to correct the JSON in the same file, then run the same command again. If it still fails, tell the user the reviewer's report is invalid and stop; never invent a review. If it refuses, check the phase.
4. Run `superagent review-close`. It removes the worktree.
5. Read the newest `.superagent/runs/<run-id>/reviews/<n>.json`. Reading it is fine; never write there. It covers every in-scope Charter item as `met` (with evidence) or `unmet`, plus `extras` and `contradictions`.
6. If `unmet` lists items that are inside the Charter, and `run.fix_waves_used.fidelity` is 0, run one fidelity wave:
   - record the decision with `superagent ruling`;
   - add `superagent add-ticket --origin fidelity` tickets (wave `max(existing ticket waves) + 1`, above every merged wave, as in the fix wave), whose scopes state the unmet outcome, not the steps;
   - run `superagent next-wave`, then phase 4, phase 5, and this phase once more.
7. Otherwise go to phase 7.
8. Never remove extras or undo contradictions yourself. List them for the user.

## 7. Final report

Run `superagent finish`, unless the run stopped in `merging`. It refuses until this pass's `verify-result` (and, from `reviewing`, a review) is recorded, and prints both. Then run `git worktree list`. Send one short report that leads with outcomes:
- What was built, as the Charter items that are met.
- Merge and verification results: the commands run, passed or failed.
- Charter fidelity: what is unmet, the extras, and any contradictions.
- Failed, dropped and handed-back tickets, one line each.
- The integration branch `superagent/<run-id>` and its base branch. Include the leftover worktrees and branches to delete, and any stash you made.
- What the user does next, for example review, merge into their base branch, or push. You do these only if the Charter allows it.

## Resume

Run `superagent context` first: it prints a compact brief (phase, wave, branch, ticket counts, any blocked question, the latest fidelity counts, and the `next` action). Then follow this section from `run.phase`; use `superagent show --json` for details.
- `proposing`: if `.superagent/drafts/<run-id>/plan.json` exists, run `superagent propose .superagent/drafts/<run-id>/plan.json`, then go to phase 2's preflight and phase 3. Otherwise ask the user for the idea, then go to phase 2.
- `awaiting_approval`: run `superagent proposal` to print the proposal again, then go to phase 3.
- `running`: reconcile first. Call ListAgents and compare the live agents with the `running` tickets. Never run two workers on one ticket.
  - A `running` ticket whose `agent_id` is listed as a live or running subagent keeps its worker; wait for its notification.
  - Any other `running` ticket has lost its worker: `start-ticket`, launch a fresh worker, `set-agent` (4a).
  - Ask each `blocked` ticket's question again (4c). `planned` and `ready` tickets are left to `next`.
  - Then go to phase 4: run `next` and do what it prints.
- `merging`: `next` prints `merge-continue <T>`. Run `git diff --name-only --diff-filter=U`.
  - If files are still conflicted, handle them as in 4d.
  - Once they are resolved (by you or the user), `git add` the resolved files and run `superagent merge-continue`.
  - If it refuses because the ticket is not merged (the merge was aborted with git), or the user wants to drop it, run `superagent merge-abort <T>` and handle it as a handback (4e), with a ruling.
  - Then go to phase 4 and let `next` merge the remaining ready tickets.
- `verifying`: go to phase 5.
- `reviewing`: go to phase 6. If `run.review_worktree` is still set, `review-setup` prints it again; record any review JSON already written under it, then `review-close`.
- `done` or `aborted`: there is nothing to resume. Say so in one line.
