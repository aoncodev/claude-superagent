# Platform notes (verified)

Verified on 2026-11-06 with Claude Code 2.1.318 on macOS, Node 26. The checks ran headlessly: `claude -p "<prompt>" --plugin-dir <repo> --dangerously-skip-permissions --output-format stream-json --verbose`, from a throwaway git repo, with a temporary probe hook (`PreToolUse`, matcher `Write|Edit|Bash`) logging its stdin. The probe files have been removed. Later tasks should treat these facts as the contract.

Summary:

| # | Verdict | Fallback needed |
|---|---|---|
| A1 | Confirmed | none (subagent identity is available, in addition to path mapping) |
| A2 | Confirmed (JSON deny works under bypass) | none; exit code 2 not needed |
| A3 | Confirmed, with details below | none; keep a defensive `git reset --hard` optional |
| A4 | Confirmed (both mechanisms work) | none |
| A5 | Confirmed (addressable and resumable, by agent id) | none |
| A6 | Confirmed (CLI install into an isolated config dir) | none |

## A1. PreToolUse stdin payload

Confirmed. Every field the plan needs is present. In a subagent, the payload also carries `agent_id` and `agent_type`; these keys are absent for the main session. The subagent's `cwd` is its own worktree.

Main session, Bash:

```json
{"session_id":"5346cd1d-...","transcript_path":"/Users/aon/.claude/projects/.../5346cd1d-....jsonl",
 "cwd":"<repo>","prompt_id":"aa413204-...","permission_mode":"bypassPermissions","effort":{"level":"high"},
 "hook_event_name":"PreToolUse","tool_name":"Bash",
 "tool_input":{"command":"echo main-bash-probe","description":"Echo probe string"},"tool_use_id":"toolu_011n..."}
```

`general-purpose` subagent in a worktree, Bash (the Write call had `tool_input` `{"file_path":"<worktree>/probe.txt","content":"hello"}`):

```json
{"cwd":"<repo>/.claude/worktrees/agent-a4813943ec0e91d18","permission_mode":"bypassPermissions",
 "agent_id":"a4813943ec0e91d18","agent_type":"general-purpose","hook_event_name":"PreToolUse",
 "tool_name":"Bash","tool_input":{"command":"pwd && git rev-parse HEAD && git branch --show-current","description":"..."}, ...}
```

`superagent:worker` subagent (no isolation): `"agent_id":"a4ac378b28f8f3f7b","agent_type":"superagent:worker"`, `cwd` = the main checkout.

Facts for the hooks:

- `agent_type` for a plugin agent is namespaced: `superagent:worker`, not `worker`.
- `agent_id` equals the Agent tool's `agentId` and the worktree directory suffix (`agent-<agent_id>`), when isolation is `worktree`.
- `permission_mode` is in the payload (`bypassPermissions` here).
- `cwd` is the working directory of the calling agent, so a worktree subagent reports its worktree, but a non-isolated subagent reports the main checkout.
- The `Write` payload uses `file_path` and `content`. (`Edit` was not exercised; the plan assumes `file_path`, which is the documented key.)
- Hook subprocesses see `CLAUDE_PLUGIN_ROOT` in their environment (value `/Users/aon/superagent/claude-superagent` under `--plugin-dir`).

Fallback: none needed.

## A2. Deny in bypass-permissions mode

Confirmed. The probe hook printed this on stdout with exit code 0 for `echo PROBE-DENY`, while the session ran with `--dangerously-skip-permissions` (payload `permission_mode: "bypassPermissions"`):

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"probe deny reason"}}
```

The command did not run. The tool result was an error, shown to the model as:

```
PreToolUse:Bash hook error: probe deny reason
```

with metadata `"non_execution_kind":"permission-rule","permission_decision":{"decision":"reject","source":"hook","reason_type":"hook"}` and `is_error: true`. The reason text reaches the model, so deny messages should say what to do instead. (The same hook fired for the subagent calls; denial from inside a subagent was not separately exercised.)

Fallback: none; exit code 2 was not needed.

## A3. `isolation: "worktree"`

Confirmed. Evidence:

- Run 1 (main on `main`, HEAD `6927b63...`): the worktree agent's `pwd && git rev-parse HEAD && git branch --show-current` printed
  ```
  <repo>/.claude/worktrees/agent-a4813943ec0e91d18
  6927b630f04af7e9d03be935bc00734cf290dfe6
  worktree-agent-a4813943ec0e91d18
  ```
- Run 2 (discriminating case): main checkout on branch `feat` at `37b604f...`, one commit ahead of `main` (`6927b63...`). The worktree agent reported HEAD `37b604f1566cbd7da39ecb450c97cf189a440101` and `ls` showed `more.txt` (from the `feat` commit), so the worktree is based on the main checkout's current HEAD, not on `main` or a remote default branch. (There was no remote in the test repo.)
- The subagent's Bash cwd is the worktree (above), and its hook payload `cwd` is the same.

Details later tasks must use:

- Location: `<repo>/.claude/worktrees/agent-<agent_id>` (inside the main repo, under `.claude/`).
- Branch: `worktree-agent-<agent_id>`, created at the main checkout's current HEAD. The Agent tool result for the agent reported it as `worktreeBranch`.
- A worktree with no changes is removed automatically when the agent finishes (run 2: `git worktree list` showed no leftover). A worktree with changes is kept (run 1: `probe.txt` remained, branch and worktree still listed).
- Uncommitted work in the worktree stays uncommitted; the platform does not commit for the agent.
- The Agent tool in this build has no `name` parameter; agents are identified by `agentId`.
- `.claude/worktrees/` shows up as untracked in the main repo (`git status` -> `?? .claude/`). The target repo (or `.git/info/exclude`) should ignore it, and `git add .` in the main checkout would add the worktree as an embedded repo (git warns).

Fallback: not needed. Since the worktree starts at the current HEAD, `claim` should still verify the HEAD equals the integration branch tip and only then reset if they differ (cheap, safe at claim time).

## A4. `${CLAUDE_PLUGIN_ROOT}` and `bin/` on PATH

Confirmed for both.

- Command markdown (`commands/a4probe.md`, run as `/superagent:a4probe`): `${CLAUDE_PLUGIN_ROOT}` was substituted before the model saw it. The model's Bash call was literally `echo ROOT=/Users/aon/superagent/claude-superagent`, and a prose line `markdown-root=${CLAUDE_PLUGIN_ROOT}` arrived as `markdown-root=/Users/aon/superagent/claude-superagent`.
- Skill markdown (`skills/a4skill/SKILL.md`): the Skill tool returned the line `Skill markdown root line: skill-root=/Users/aon/superagent/claude-superagent`, so it is expanded there too.
- `bin/` on PATH: with an executable `bin/superagent-probe-bin` in the plugin, the Bash tool ran `which superagent-probe-bin` -> `/Users/aon/superagent/claude-superagent/bin/superagent-probe-bin`, and the `PATH` contained `/Users/aon/superagent/claude-superagent/bin`. So an executable `bin/superagent` (no extension, with a `#!/usr/bin/env node` shebang) would be callable as `superagent`. `bin/superagent.mjs` itself is only reachable by full path.
- Hook commands: `${CLAUDE_PLUGIN_ROOT}` in `hooks.json` command strings worked (the probe ran from `node "${CLAUDE_PLUGIN_ROOT}/hooks/probe.mjs"`).

Caveats: this was observed with `--plugin-dir`. For a marketplace-installed plugin, the root is the install cache path instead of the repo path; the variable and PATH mechanism are the same, but that was not exercised with a live session (see A6). A command's `allowed-tools` frontmatter must permit the Bash calls it asks for, or a non-bypass session will prompt.

Note a naming gotcha: a command and a skill with the same name (both `a4probe`) collide as `superagent:a4probe`; the command shadowed the skill. Keep names distinct (for example a skill `run` and a command `start`, not both `run`).

Fallback: none needed. If a skill wants the CLI, it can use `${CLAUDE_PLUGIN_ROOT}/bin/superagent.mjs` directly.

## A5. Plugin agents and SendMessage

Confirmed.

- `agents/worker.md` in the plugin is addressable as `subagent_type: "superagent:worker"`; the Agent call was accepted and the subagent ran (`agentType: "superagent:worker"` in the result; hook payload `agent_type: "superagent:worker"`).
- A finished (foreground, completed) `general-purpose` agent was continued with `SendMessage` using its agent id:
  ```
  SendMessage {"to":"a4813943ec0e91d18","message":"Reply with the word pong", ...}
  -> {"success":true,"message":"Resuming agent a481394","resumedAgentId":"a4813943ec0e91d18","revivedAgentId":"a4813943ec0e91d18",...}
  ```
  A task notification followed with `status: completed` and result `pong`. The resumed agent kept its worktree and branch.
- `SendMessage` is a deferred tool: in a headless session the model had to load it first (`ToolSearch` with `select:SendMessage`). Skills and agents that use it should say so or the model will do it unprompted, as it did here.
- Limits of this check: continuation was tested within the same session that spawned the agent. Resuming across sessions was not tested (that remains the "fresh worker" path in the design). The Agent tool has no `name` parameter in this build, so address agents by `agentId`, which the Agent tool result returns.

Fallback: not needed for same-session resume.

## A6. Local marketplace install

Confirmed via the CLI, in an isolated config directory so the real Claude Code config was not touched (`CLAUDE_CONFIG_DIR=<scratch>/cfg`):

```
$ claude plugin marketplace add /Users/aon/superagent/claude-superagent
Successfully added marketplace: superagent-local (declared in user settings)
$ claude plugin install superagent@superagent-local
Successfully installed plugin: superagent@superagent-local (scope: user)
$ claude plugin list
  superagent@superagent-local   Version: 0.1.0   Status: enabled
```

`claude plugin validate .claude-plugin/marketplace.json` -> "Validation passed". `claude plugin validate .` passes for the plugin too; it also lists directory-submission checks (README, LICENSE, icon) that do not affect the result and are not needed for local use.

The slash-command forms (`/plugin marketplace add <path>`, `/plugin install superagent@superagent-local`) are the interactive equivalents of these CLI commands; they were not run interactively. A live session using the installed copy (rather than `--plugin-dir`) was not run, because the isolated config has no login. To be checked by hand in Task 9: start a normal session after install and confirm `/superagent:...` commands, the hooks and `bin/` on PATH come from the installed copy.

Fallback: not needed; document both the CLI and slash-command install forms in the README.
