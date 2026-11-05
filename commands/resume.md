---
description: Resume the active superagent run from its current phase, after a new session or a context compaction.
---

Run `superagent status`. If it exits 2 (no active run), say so and point the user to `/superagent:start`.

Otherwise use the superagent:orchestrate skill, and follow its Resume section from the run's current phase:
- `running` tickets with no live agent get a fresh worker;
- `blocked` tickets get their question asked again.
