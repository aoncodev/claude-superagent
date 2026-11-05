---
description: Resume the active superagent run from its current phase, after a new session or a context compaction.
---

Run `superagent status`. If it exits 2 (no active run), say so and point the user to `/superagent:start`.

Otherwise use the superagent:orchestrate skill, and follow its Resume section from the run's current phase:
- For each `running` ticket, call ListAgents (load it with ToolSearch `select:ListAgents` if needed) to check whether its recorded `agent_id` is still live:
  - if it is live, keep that worker and wait for its notification;
  - if it is not, give the ticket a fresh worker (`start-ticket`, launch, `set-agent`).
- Never run two workers on one ticket.
- Ask each `blocked` ticket's question again.
