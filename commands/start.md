---
description: Start a superagent run. It splits an idea into parallel tickets, runs isolated workers, then merges, verifies and reviews the result.
argument-hint: <idea text, or path to a spec file>
---

Use the superagent:orchestrate skill to start a new run for: $ARGUMENTS

Before phase 1, run `superagent status`:
- If it exits 0, a run is already active. Do not start another. Show its output and point the user to `/superagent:resume` to continue it, or `/superagent:abort` to drop it.
- If it exits 2 with "no active run", go on with the skill from phase 1.

If no idea was given above, ask the user for it first.
