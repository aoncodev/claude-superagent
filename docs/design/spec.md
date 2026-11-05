# Claude Superagent: design

Date: 2026-11-06
Status: draft for approval

## Intent

The user is a solo developer on a Claude Max plan who builds full web apps (frontend and backend), database work, mobile apps, servers, and CI/CD with tests. Builds take a long time because one agent works through them one task at a time. The Superpowers plan-then-subagent flow keeps quality up but runs sequentially, which the user found too slow.

The user wants Claude Code to **divide a piece of work, assign the parts to several agents running in parallel, and keep each agent's context separate, without drifting from the original idea.** The goal is to use more of the Max plan's capacity to build faster, while staying as accurate as one careful agent.

The design adapts the ideas of dsh-superagent (`/Users/aon/superagent/dsh-superagent-prototype`, a DeepSeek Harness research prototype) to this personal, in-session use. It keeps the ideas that protect accuracy and attention, and drops the ones that exist to serve a team-wide, always-on GitHub/Feishu bot.

### Ideas carried over from dsh-superagent

| dsh-superagent idea | Here |
|---|---|
| The original request is the source of truth; the orchestrator routes and never rewrites it into its own plan; workers derive requirements from the original | The **Charter**: the user's idea in their own words, frozen after approval, given verbatim to every worker and used for the final review |
| Mandate: an immutable grant of scope; wider scope means a new ticket | Each **Ticket** has a fixed scope and owned paths; a worker hands back anything outside it instead of expanding |
| Worker per Ticket in its own Session and directory (git worktree) | One worker subagent per Ticket, in an isolated git worktree |
| Structured reports: progress / waiting / ready / blocked / failed / dropped | Worker final reports with a fixed status set (see Reports) |
| One concrete question at a time, in a structured field, not buried in a long report | A worker that needs a decision ends with exactly one question; the orchestrator asks the user, then resumes that worker |
| Take as little human attention as possible; stay quiet while working; speak when a result is ready, a decision is needed, or work cannot finish | Same rule for what the orchestrator tells the user during a run |
| Host enforces permissions; text cannot change them | Hooks enforce file ownership and Charter immutability; prompts alone are not trusted for that |
| Model-visible means logged (DeepSeek Harness) | Every run's Charter, Contracts, Tickets, reports, and decisions live on disk so a run can be inspected and resumed |
| Panel shows only what needs a person | A status command that leads with what needs the user |
| Reports honestly: a draft is marked unfinished; a failure is a failure | Same |

### Ideas deliberately not carried over

GitHub/Feishu event listening, allowed-sender lists, admission rules and proactive "observe/auto" modes, policy versions, cross-thread subscriptions, the web panel, and the always-on daemon. These serve a bot acting for a whole team. They may be revisited later; they are out of scope now.

## Goals

1. Turn one idea from the user into a split of parallel Tickets the user approves in one step.
2. Run independent Tickets at the same time, each worker isolated in context and in files.
3. Keep every worker anchored to the user's original idea; catch drift before the result is handed back.
4. Interrupt the user only for: approving the split, a concrete decision only they can make, an unrecoverable failure, and the final result.
5. Work across stacks (web frontend and backend, databases, mobile, servers, CI/CD) by discovering the project's own build and test commands rather than assuming a stack.
6. Make runs resumable after the session ends or context is compacted.

## Non-goals

- Listening to GitHub, chat apps, or any external event source.
- Multi-user use, permissions for other people, or a web dashboard.
- Replacing the user's brainstorming or design process. The plugin starts from an idea or spec the user gives it.
- Automatic deployment.

## Anti-goals (would count as failure even if the code works)

- **Drift:** the delivered result does what the plan says but not what the user asked for, or adds things nobody asked for.
- **Silent scope growth:** a worker "helpfully" changes files or behaviour outside its Ticket.
- **Collisions:** parallel workers overwrite or conflict with each other's files.
- **Noise:** chatty progress updates, or several questions at once, during a run.
- **False completion:** reporting done when tests fail, a Ticket was skipped, or a merge was incomplete.
- **Unapproved outward actions:** pushing to a shared remote, deploying, touching production servers or databases, or changing CI secrets without the user saying so in the approved split.
- **Slower than one agent** on a job that has real parallelism in it.

## The flow, from the user's side

1. The user runs the start command with an idea (free text, or a path to a spec file).
2. The orchestrator reads the project (stack, build/test commands, structure) and prepares the **split proposal**, shown on one screen:
   - the **Charter**: the idea in the user's own words, plus in-scope and out-of-scope lines and any outward actions allowed;
   - the **Contracts** it will settle first (API shapes, database schema, shared types, environment variables, file and folder layout);
   - the **Tickets**, each with a title, a one-to-three-line scope, owned paths, and the Contracts it depends on, grouped into **waves**;
   - the parallelism it will use.
3. The user approves, or says what to change; the orchestrator revises and shows the proposal again. Nothing is built before approval.
4. The run proceeds without check-ins: Contracts wave, then Ticket waves in parallel, then merge, verification, and fidelity review.
5. The user is interrupted only for the four reasons in Goal 4. While a question is pending, other workers keep going.
6. The run ends with a **final report**: what was built, merge and test/build results, how the result matches the Charter (with any gaps or extras listed), Tickets that failed or were handed back, and anything the user must do next.

## New projects and existing codebases

The plugin supports both, and the user uses both.

- **Existing codebase**: the orchestrator reads the project to discover the stack, structure, and build/test commands, and plans around what is there.
- **New project (empty or near-empty folder)**: the split proposal also includes a **stack choice** (languages, frameworks, database, package manager, test tooling, and for mobile, the platform approach). The orchestrator proposes it, matching anything the user's idea already states; the user approves it with the rest of the split.
  - After approval, a **scaffold wave** runs before the Contracts wave. One agent creates the skeleton every Ticket depends on: git repository, manifests and lockfiles, folder layout, base config, a working build and test command, and a minimal passing test.
  - The scaffold is merged and verified (build and test pass) before Contracts and parallel Tickets start, so every worktree begins from a working base.

## Concepts

- **Run**: one execution of the flow for one idea. It has an id and a folder.
- **Charter**: the user's original idea, verbatim, plus scope lines and allowed outward actions. Frozen when the user approves the split. It is never summarised or rewritten for workers. If the user changes the idea mid-run, that is a new Charter revision, and the orchestrator re-checks the affected Tickets.
- **Contract**: a decision several Tickets depend on, written down before parallel work starts (for example an OpenAPI or typed API description, a schema or migration file, shared type definitions, env var names). Contracts are the reason frontend, backend, database, mobile, and CI work can proceed at the same time.
- **Ticket**: one unit of parallel work. Fields: id, title, scope (what to achieve, stated as outcome, not as implementation steps), owned paths (globs), read-only context paths, Contracts used, "done when" (observable checks derived from the Charter), and wave. Tickets in the same wave never own overlapping paths.
- **Shared files**: files many Tickets would naturally touch (package manifests, lockfiles, root config, route registries, CI workflow files). They belong to the Contracts wave or to an integration step owned by the orchestrator. Workers that need a change there hand it back.
- **Worker**: a subagent that executes exactly one Ticket in its own git worktree. Its context is the Charter, the relevant Contracts, its Ticket, and the project's own instruction files (such as CLAUDE.md), and nothing from other Tickets' work.
- **Report**: the worker's final structured output (see below).
- **Handback**: a request or need the worker found outside its Ticket. The orchestrator decides: new Ticket in a later wave, fold into integration, or raise with the user if it changes the Charter.

## Reports

Every worker ends with one report:

- `status`: one of
  - `ready`: done, verified within its scope, committed on its worktree branch;
  - `blocked`: needs a decision only the user can make; carries exactly one `question`;
  - `failed`: could not finish, with what was tried and what remains;
  - `dropped`: on inspection, the Ticket should not be done as scoped (for example it would require changing behaviour the Charter excludes), with the reason.
- `summary`: at most 100 words, stating outcomes, not a narrative.
- `changed_files`, `branch`, `commits`.
- `checks`: the commands run and their pass/fail result.
- `handbacks`: zero or more items outside the Ticket, each with a one-sentence reason.
- `question`: present only when `blocked`; one concrete question, with the options the worker sees, if any.

The orchestrator relies on reports and on-disk state, never on reading worker transcripts. This keeps its own context small.

## Orchestrator rules

- Splits and routes work; settles Contracts; merges; asks the user. Does not implement Tickets itself.
- Gives each worker the Charter verbatim. Ticket scope says what, never how; workers own technical choices within their scope.
- Never widens a Ticket's scope. New needs become new Tickets or user questions.
- Asks the user one question at a time. When several are pending, asks the most blocking one first.
- Stays quiet during routine progress. Does not repeat an unchanged status.
- Treats a `blocked` worker as paused, not finished: after the user answers, the same worker resumes with its context intact.
- Re-plans only through the user: a change to the Charter or to the approved set of Tickets beyond handback-generated Tickets is shown to the user first.

## Enforcement (deterministic, not prompt-only)

Following dsh-superagent's "the host enforces, text cannot change permissions". The user runs Claude Code with permission prompts bypassed, so these hooks are the safety layer, and nothing may rely on a permission prompt appearing.

- **File ownership, two layers**:
  - a PreToolUse hook blocks Edit/Write (and similar file tools) outside the Ticket's owned paths. The hook identifies the Ticket from the worker's working directory (its worktree) and the run state on disk;
  - before merging, a deterministic check compares the worker branch's diff with its owned paths. This catches writes made through Bash, generators, or package managers. A Ticket with out-of-scope changes is not merged: those changes are treated as a handback.
- **Charter immutability**: a hook blocks writes to the frozen Charter from any agent, including the orchestrator. Revisions go through the start/revise command after the user agrees.
- **Outward actions**: a PreToolUse hook on Bash **blocks** (does not ask) pushes to remotes, deploy commands, and commands matching the project's production markers, unless the approved Charter lists that action. Production markers (hosts, database URLs, deploy commands) come from an optional per-project config, which the orchestrator proposes in the split when it sees deploy or server work. Without that config, the hook blocks `git push` and a small generic deny list, and the orchestrator does not run deploy steps.

## Merging and verification

1. After each wave, the orchestrator merges the `ready` Tickets' branches into the run's integration branch, in a fixed order (Contracts first, then by Ticket id).
2. Merge conflicts in owned paths should not happen. If one does, it means the split was wrong; the orchestrator resolves only trivial conflicts in shared files and otherwise reports it.
3. After the final wave: run the project's full build and test commands on the integration branch. On failure, the orchestrator may create fix Tickets (one more wave) automatically, up to a small limit, then report.
4. **Fidelity review**: a separate reviewer agent, which has not seen the plan's reasoning, compares the integrated result against the Charter (not against the Tickets) and lists unmet items, extras nobody asked for, and contradictions.
   - Unmet items that are clearly inside the Charter get one automatic fix wave, followed by one more review pass.
   - Extras and contradictions are reported, not removed automatically: deleting work is the user's call.
   - The final report includes whatever is still on the list.
5. The integration branch is left for the user. Merging into their main branch or pushing happens only if the Charter allows it.

## Worker environment and checks

- Each worktree gets its own dependency install. Untracked local env files (such as `.env*`) are copied from the main checkout into the worktree at creation and stay git-ignored.
- Workers verify only with checks that are safe to run in parallel: unit tests, type checks, lint, and builds of their part. They do not start shared services, use the shared local database, or bind fixed ports.
- Integration and end-to-end tests, migrations against a real database, and anything needing running services happen once, on the integration branch, after the final wave.
- A Ticket's "done when" is written in terms of these parallel-safe checks. Integration checks belong to the run's final verification.

## State on disk

Each project gets a `.superagent/` folder (git-ignored by default) holding one folder per run:

- the Charter (and its revisions);
- the Contracts list and pointers to the Contract files in the repo;
- one file per Ticket, with its fields and current status;
- one report file per worker attempt;
- an append-only event log of decisions (approval, wave start/end, questions asked and answered, handbacks, merges, verification results).

A resume command rebuilds the orchestrator's view from this folder, so a run survives context compaction and a new session.

Within one session, a `blocked` worker is resumed as the same subagent, with its context intact. After a new session, live subagents are gone, so resume starts a fresh worker on the same worktree. For that reason, a `blocked` or `failed` report must hold enough to continue: work done so far, what remains, the question, and (once given) the user's answer.

## Packaging

A standalone Claude Code plugin (working name `superagent`), developed in `/Users/aon/superagent/claude-superagent/`. It contains:

- slash commands: start a run with an idea or spec path; show status (leading with what needs the user); resume a run; optionally abort a run;
- the orchestrator skill (the rules above, the split-proposal format, the wave loop);
- agent definitions: worker, fidelity reviewer, and, if the builder finds it useful, a merge/integration helper;
- hooks for the enforcement rules;
- a small script or module for reading and writing run state, used by both the hooks and the agents.

It must not depend on the Superpowers plugin, and must not conflict with it when both are installed.

## Constraints

- Runs inside Claude Code on macOS; uses Claude Code's own subagent and git worktree support for parallel workers.
- Max plan rate limits cap useful parallelism. Default to **4 concurrent workers**, configurable per run and in plugin settings.
- The target project must be a git repository; the start command offers to initialise one if not.
- Must work on any stack: no stack-specific logic in the core. Discovering build/test commands is the orchestrator's job, using project files and instructions.

## Decisions made by the assistant (not yet confirmed by the user)

- Standalone plugin rather than an extension of Superpowers.
- Parallel workers are Claude Code subagents (Agent tool) with worktree isolation, not separate `claude -p` processes or the Workflow tool. Reason: subagents stay addressable, so a `blocked` worker can be resumed with its context after the user answers.
- Default parallelism of 4.
- State in a git-ignored `.superagent/` folder in the target project.
- Worker model inherits the session's model by default; configurable.
- Automatic fix-wave limit after failed verification: 1 wave, then report.
- The user runs with permission prompts bypassed, so hooks are the only safety layer. Outward actions are blocked, not confirmed.
- File ownership: Edit/Write hook plus a diff check before merge (catches Bash writes), rather than sandboxing.
- Workers run only parallel-safe checks; integration and end-to-end tests run once after the final wave.
- Fidelity review: unmet items get one fix wave; extras are reported, never auto-deleted.
- After a new session, a blocked worker resumes as a fresh worker from its worktree and report.
- For new projects, the orchestrator proposes the stack in the split, and a single-agent scaffold wave runs before parallel work.

## Left to the builder

- Exact file formats for run state (Markdown with front matter, JSON, or both).
- Exact command names and argument syntax.
- How hooks map a worker's working directory to its Ticket, provided the mapping is reliable.
- How the split proposal is rendered, provided it fits on one screen for a typical run (about 5–12 Tickets).
- Whether the merge step is done by the orchestrator directly or a helper agent.
- How the plugin is tested. It should be exercised end-to-end at least once on a small sample full-stack project with real parallelism (for example a backend endpoint, a frontend page, and a migration).
