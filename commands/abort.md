---
description: Abort the active superagent run. Its branches and worktrees are left for you to keep or delete.
---

1. Run `superagent show --json`. If it exits 2 (no active run), say so and stop. Otherwise note `run.id`, `run.base_branch` and `run.integration_branch`.
2. Confirm with one AskUserQuestion (load it with ToolSearch `select:AskUserQuestion` if needed): "Abort run <id>? Nothing is deleted; its branches and worktrees stay." Offer the options Abort and Keep running. If the user picks Keep running, stop.
3. If workers of this run are still running in this session, stop them (TaskStop; load it with ToolSearch `select:TaskStop` if needed).
4. Run `superagent abort`.
5. Run `git worktree list` and `git branch --list 'superagent/*' 'worktree-agent-*'`. Report what is left for the user to keep or delete:
   - the integration branch. The main checkout is still on it; `git checkout <base_branch>` returns to where they started;
   - each worker worktree and branch.

   Do not delete anything yourself.
