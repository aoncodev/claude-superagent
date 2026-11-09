# superagent evals

A small harness for the question in `docs/design/spec.md`: does superagent build things faster than one careful agent at the same accuracy? It compares three ways of building one fixture idea and reports the numbers from the run's own state.

## The three arms

| Arm | Scheduling | What it is |
|---|---|---|
| `single` | one agent | A single Claude session implements the whole idea itself. This is the baseline: no split, no workers, no orchestration overhead. |
| `waves` | wave barriers | Superagent with the v0.1 rule: the next wave launches only after every ticket in the previous wave has merged. |
| `frontier` | `superagent next` | The shipped v0.2 behaviour: `superagent next` launches any ticket whose `depends_on` are merged, so independent work starts as soon as it is ready. |

All three use the same fixture idea (the bookmarks app from `skills/orchestrate/proposal-format.md`) and the same plugin checkout, so the scheduling rule is the only difference. The waves arm is emulated through the prompt: it is told to use `next-wave` barriers rather than `next`.

## What is measured

`evals/metrics.mjs` exports `metricsForRun(root, runId)`. It returns the same object as `superagent stats --json`: `id`, `title`, `phase`, `wave`, `parallelism`, `created_at`, `finished_at`, `duration_seconds`, `tickets_total`, `tickets_by_status`, `tickets_by_origin`, `attempts`, `blocked_events`, `merge_conflicts`, `merges`, `verifications`, `reviews`, `fix_waves_used`, `events_total`. It adds one field, `human_interventions`: the number of `approved` plus `answered` events, i.e. how often a person had to do something.

Together they answer the two halves of the goal:

- **Speed**: `duration_seconds`, plus `merges` and `verifications` to confirm the run actually integrated and checked the result.
- **Accuracy and attention**: `verifications`, `reviews` and `tickets_by_status` show whether the result was verified and reviewed; `blocked_events`, `merge_conflicts` and `human_interventions` show how much work needed a person or got stuck.
- **Cost/effort**: `attempts` counts worker launches, including relaunches.

A live run also records each arm's wall-clock time and exit code in the JSON summary that `--live` prints.

## Running

Dry run (the default) prints the exact `claude -p` command for each arm. It does not call `claude` or modify a repository; it only creates a temporary work root for the paths in the commands.

```
node evals/run.mjs
```

Live:

```
node evals/run.mjs --live
```

`--live` needs the Claude Code CLI on `PATH`. For each arm it creates a fresh temporary git repository, runs:

```
cd <repo> && CLAUDE_CONFIG_DIR=<temp dir> claude -p '<arm prompt>' --plugin-dir <this checkout> --dangerously-skip-permissions --output-format stream-json --verbose
```

and then computes `metricsForRun` from whatever run the arm left in `<repo>/.superagent/`. The summary (one object per arm) is printed as JSON. Nothing touches the user's real `~/.claude` configuration: every arm shares one throwaway `CLAUDE_CONFIG_DIR` under the temporary work root.

`--dangerously-skip-permissions` is required because the harness runs headless. That is another reason to run evals only in throwaway folders, and only on a machine where you are comfortable with a headless agent editing temp repositories.

## Caveats

- Live mode is unverified in this checkout: it needs an authenticated Claude Code CLI. The dry run is what CI-style checks exercise.
- The arms are not perfectly isolated experiments: rate limits, model choice and the session model all affect wall-clock numbers. Run each arm more than once before drawing conclusions.
- `waves` is prompt-pinned, not a separate plugin version. It measures the scheduling rule, not a released old build.
- Fixture repositories are left under the temp work root after a run so the output can be inspected; delete them when you are done.
