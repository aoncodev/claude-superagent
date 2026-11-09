---
description: Resume the active superagent run from its current phase, after a new session or a context compaction.
---

1. Run `superagent context`. If it exits 2 (no active run), say so and point the user to `/superagent:start`.
2. Otherwise use the superagent:orchestrate skill, and follow its Resume section from the phase the brief prints. The brief also carries the `next` action and any blocked question, so it is the first thing to read.
3. Reconcile before launching anything: call ListAgents (load it with ToolSearch `select:ListAgents` if needed) and compare the live agents with the `running` tickets:
   - a `running` ticket whose recorded `agent_id` is live keeps its worker; wait for its notification;
   - any other `running` ticket gets a fresh worker (`start-ticket`, launch, `set-agent`).
   Never run two workers on one ticket.
4. Ask each `blocked` ticket's question again, then let `superagent next` drive the rest.
