# superagent evals

A small harness for the question in `docs/design/spec.md`: does superagent build things faster than one careful agent at the same accuracy? It compares three ways of building one fixture idea, records speed, cost and attention, and runs an independent acceptance check so a fast arm that does not work cannot look good.

## The three arms

| Arm | Scheduling | What it is |
|---|---|---|
| `single` | one agent | A single Claude session implements the whole idea itself. This is the baseline: no split, no workers, no orchestration overhead. |
| `waves` | wave barriers | Superagent with the v0.1 rule: the next wave launches only after every ticket in the previous wave has merged. |
| `frontier` | `superagent next` | The shipped v0.2 behaviour: `superagent next` launches any ticket whose `depends_on` are merged, so independent work starts as soon as it is ready. |

All three use the same fixture idea (the bookmarks app from `skills/orchestrate/proposal-format.md`) and the same plugin checkout, so the scheduling rule is the only difference. The waves arm is emulated through the prompt: it is told to use `next-wave` barriers rather than `next`.

Every arm prompt is headless-safe. It states that the proposal is pre-approved exactly as shown (so the arm does not stall at the approval gate) and that, because `AskUserQuestion` is unavailable in `claude -p`, any worker question must be answered with the most conservative option. The prompt text is part of the dry-run output and is tested.

## What is measured

### Accuracy: the arm's own test command

For every arm run, `evals/accept.mjs <repo>` independently checks the result:

1. the arm's repository must be a git repository with at least one commit;
2. if `package.json` has a non-empty `scripts.test`, run `npm test` there;
3. else if a `Makefile` exists, run `make test` there;
4. else the check fails with `no test command`.

It prints `PASS`/`FAIL` and a short output tail, and exits 0/1. Accuracy in an eval table is the acceptance pass rate, i.e. how many repetitions of that arm left a repository that passes its own tests. The acceptance check is deliberately independent of the arm: it does not read `.superagent/` state and does not trust the arm's own report.

### Speed, cost and attention: run metrics

`evals/metrics.mjs` exports `metricsForRun(root, runId)`. It returns the same object as `superagent stats --json`: `id`, `title`, `phase`, `wave`, `parallelism`, `created_at`, `finished_at`, `duration_seconds`, `tickets_total`, `tickets_by_status`, `tickets_by_origin`, `attempts`, `blocked_events`, `merge_conflicts`, `merges`, `verifications`, `reviews`, `fix_waves_used`, `events_total`. It adds one field, `human_interventions`: the number of `approved` plus `answered` events, i.e. how often a person had to do something. The `single` arm has no superagent run, so it has no metrics; the superagent arms are the only ones with a metrics mean.

Each arm run also records its wall-clock time in milliseconds and its `claude` exit code. Wall-clock covers the whole `claude -p` session, including planning, worker launches and merges, so it is the honest end-to-end number for "how long did this take"; the run metrics' `duration_seconds` is the run's own view from `created_at` to `finished`.

### Aggregation

For `--runs N` repetitions, the harness reports per arm:

- wall-clock **min / median / max** in milliseconds;
- the **exit codes** of the `claude` calls;
- the **acceptance pass rate** (passed runs / all runs);
- the **mean** of each numeric superagent metric where present (including `human_interventions`), skipping runs whose state was missing or unreadable.

It writes the full per-run records plus the aggregates as one JSON object under `evals/results/` and prints a table. `evals/results/` is git-ignored; delete old JSON files when you no longer need them.

## Running

Dry run (the default) prints the exact `claude -p` command, prompt and acceptance command for every arm and every repetition, plus the authentication pre-check. It does not call `claude`, does not set up git repositories and does not touch a project repository; it only creates a temporary work root for the paths in the commands.

```
node evals/run.mjs
```

Live (not verified in this checkout — see Caveats):

```
node evals/run.mjs --live --runs 3
```

- `--live` executes the arms. Before any arm it runs a minimal `claude -p "reply ok"` with exactly the environment/config the arms will use. If that fails, it stops with a message naming the Claude Code login (run `claude` or `claude /login`) or `ANTHROPIC_API_KEY`; no arm is executed and no results file is written.
- Default config: the caller's real Claude Code login and configuration are used. Nothing is copied and the user's credentials are never read, written or copied by this harness.
- `--isolated-config`: every live call instead gets one throwaway `CLAUDE_CONFIG_DIR` under the temporary work root. A throwaway config dir has no login, so this mode **requires `ANTHROPIC_API_KEY`** in the environment; the harness fails early with that message when it is missing.
- `--runs N` (default 1) repeats every arm N times, each in a fresh temporary git repository. Aggregate statistics need more than one sample: run at least **3** repetitions per arm (5 or more is better) before comparing arms, and compare medians rather than single runs.

Each arm run is:

```
cd <fresh temp repo> && claude -p '<arm prompt>' --plugin-dir <this checkout> --dangerously-skip-permissions --output-format stream-json --verbose
```

and the acceptance check is:

```
node evals/accept.mjs <fresh temp repo>
```

`--dangerously-skip-permissions` is required because the harness runs headless. That is another reason to run evals only in throwaway folders, and only on a machine where you are comfortable with a headless agent editing temporary repositories. The fixture repositories and the results file are left under the temporary work root / `evals/results/` so the output can be inspected.

## Caveats

- **Live mode is unverified in this checkout.** It needs an authenticated Claude Code CLI and makes real model calls. Only the dry run, the aggregation and `evals/accept.mjs` are exercised here; the live plumbing (auth pre-check, arm execution, results file) has not been run end-to-end here.
- **Sample size.** Wall-clock is noisy: rate limits, model choice, network and machine load all move it. One run per arm cannot answer the speed question. Use at least 3 repetitions, preferably interleaved by hand if you care about drift, and report min/median/max rather than a single number.
- **Accuracy is the arm's own test command.** An arm can pass its project tests while still missing part of the idea; the acceptance check answers "does the result work by its own tests", not "does it match the Charter". Use `human_interventions`, `verifications` and `reviews` as the attention/quality signals alongside it.
- The arms are not perfectly isolated experiments: they share the Claude Code account, the plugin checkout and the machine. Run each arm more than once before drawing conclusions.
- `waves` is prompt-pinned, not a separate plugin version. It measures the scheduling rule, not a released old build.
- All arms load the same plugin checkout (`--plugin-dir`) so the environment is identical; the `single` arm's prompt tells it not to use the plugin, and it has no superagent run or metrics.
