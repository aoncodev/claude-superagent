# superagent evals

A small harness for the question in `docs/design/spec.md`: does superagent build things faster than one careful agent at the same accuracy? It compares three ways of building one fixture idea, records speed, cost and attention, and runs a harness-owned acceptance check, so a fast arm that does not satisfy the fixture contract cannot look good.

## The three arms

| Arm | Scheduling | What it is |
|---|---|---|
| `single` | one agent | A single Claude session implements the whole idea itself. This is the baseline: no split, no workers, no orchestration overhead. |
| `waves` | wave barriers | Superagent with the v0.1 rule: the next wave launches only after every ticket in the previous wave has merged. |
| `frontier` | `superagent next` | The shipped v0.2 behaviour: `superagent next` launches any ticket whose `depends_on` are merged, so independent work starts as soon as it is ready. |

All three use the same fixture idea and contract and the same plugin checkout, so the scheduling rule is the only experimental difference. The waves arm is emulated through the prompt: it is told to use `next-wave` barriers rather than `next`.

Every arm prompt is headless-safe. It states that the proposal is pre-approved exactly as shown (so the arm does not stall at the approval gate) and that, because `AskUserQuestion` is unavailable in `claude -p`, any worker question must be answered with the most conservative option. The prompt text, including the contract below, is part of the dry-run output and is tested.

## The fixture contract

The fixture is a small bookmarks web app. It is not judged by its own tests; every arm must satisfy this explicit HTTP contract, which `evals/accept.mjs` drives independently:

- **Start:** `npm start` (a non-empty `package.json` `scripts.start`) or, when there is no start script, `node server.js`. The app must listen on `process.env.PORT` and be reachable at `127.0.0.1`.
- **Store:** bookmarks must be stored durably in SQLite or a JSON file. When `BOOKMARKS_DB` is set, the app must use it as the database file path. The acceptance test sets it to a file in a fresh temporary directory, so every run starts with an empty database.
- **Create:** `POST /api/bookmarks` with a JSON body `{ "url": string, "title": string }` responds with HTTP 200 or 201 and saves the bookmark.
- **List:** `GET /api/bookmarks` responds with HTTP 200 and a JSON array of bookmark objects, each with at least `url` and `title`, newest first.

The app's own tests are welcome but they are not the accuracy measure. A repository whose own `npm test` passes but whose app does not follow this contract fails the eval.

## What is measured

### Accuracy: the harness-owned contract test

For every arm run, `evals/accept.mjs <repo>` does the following, and exits 0 only when all of it passes:

1. find the start command (`npm start`, else `node server.js`) and install declared runtime dependencies if `node_modules` is missing;
2. pick a free TCP port and a fresh temporary database path, start the app with `PORT` and `BOOKMARKS_DB` in its environment, and wait up to 20 seconds for it to answer;
3. `POST /api/bookmarks` with two bookmarks, ~1.1 seconds apart;
4. `GET /api/bookmarks` and assert both bookmarks are present, each has non-empty `url` and `title` fields with the expected values, and the newer bookmark comes first;
5. stop the app (and the child process `npm start` spawns) and remove the temporary database directory.

Failures name the reason: `no start command`, `did not start` (exited early or the start command failed), `timed out`, `wrong status`, `missing bookmark`, `missing field`, `wrong title`, or `wrong order`; the app's output tail is printed too. Exit is 0 on pass and 1 on fail.

Accuracy in an eval table is the acceptance pass rate: how many repetitions of that arm left an app that satisfies the contract. The check does not read `.superagent/` state and does not trust the arm's own tests or report.

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
ANTHROPIC_API_KEY=... node evals/run.mjs --live --runs 3
```

- **Eval config (default): isolated and reproducible.** Live runs get one throwaway `CLAUDE_CONFIG_DIR` under the temporary work root, so the caller's global plugins, hooks and `CLAUDE.md` are not loaded and do not distort the comparison. A throwaway config dir has no login, so the default mode **requires `ANTHROPIC_API_KEY`**. If it is missing the harness stops before any arm with a message naming `ANTHROPIC_API_KEY` and `--user-config`.
- **`--user-config`:** explicitly uses the caller's real Claude Code configuration and login instead. This loads global plugins, hooks and `CLAUDE.md` into every arm, so the harness prints one warning saying so. Nothing is copied and the user's credentials are never read, written or copied by this harness.
- **`--isolated-config`:** accepted alias for the default isolated config.
- `--live` runs a minimal `claude -p "reply ok"` with exactly the environment/config the arms will use before any arm. If that fails, it stops with a message naming the Claude Code login (run `claude` or `claude /login`) or `ANTHROPIC_API_KEY`; no arm is executed and no results file is written.
- `--runs N` (default 1) repeats every arm N times, each in a fresh temporary git repository. Aggregate statistics need more than one sample: run at least **3** repetitions per arm (5 or more is better) before comparing arms, and compare medians rather than single runs.

Each arm run is:

```
cd <fresh temp repo> && CLAUDE_CONFIG_DIR=<throwaway> claude -p '<arm prompt>' --plugin-dir <this checkout> --dangerously-skip-permissions --output-format stream-json --verbose
```

(the `CLAUDE_CONFIG_DIR` prefix is absent with `--user-config`), and after it the harness runs:

```
node evals/accept.mjs <fresh temp repo>
```

`--dangerously-skip-permissions` is required because the harness runs headless. That is another reason to run evals only in throwaway folders, and only on a machine where you are comfortable with a headless agent editing temporary repositories. The fixture repositories and the results file are left under the temporary work root / `evals/results/` so the output can be inspected.

## Caveats

- **Live mode is unverified in this checkout.** It needs `ANTHROPIC_API_KEY` (or `--user-config` with a logged-in Claude Code CLI) and makes real model calls. Only the dry run, the aggregation and `evals/accept.mjs` are exercised here; the live plumbing (auth pre-check, arm execution, results file) has not been run end-to-end here.
- **Sample size.** Wall-clock is noisy: rate limits, model choice, network and machine load all move it. One run per arm cannot answer the speed question. Use at least 3 repetitions, preferably interleaved by hand if you care about drift, and report min/median/max rather than a single number.
- **Accuracy is the contract, not the Charter.** The acceptance test answers "does the app satisfy the fixture's HTTP contract", not "does it match the user's Charter". An arm can pass the contract while missing part of the idea; use `human_interventions`, `verifications` and `reviews` as the attention/quality signals alongside it.
- **The contract is strict.** An arm that builds a working app with a different port, a different database env var, the wrong HTTP status or oldest-first listing fails acceptance even if its own tests pass. That is intentional: it keeps every arm measured against the same independent check.
- **The default isolated config controls configuration, not the account.** Arms still share the same machine, network, rate limits and `--dangerously-skip-permissions` policy. `--user-config` additionally loads the caller's global plugins, hooks and `CLAUDE.md`; the harness warns once when it is used.
- `waves` is prompt-pinned, not a separate plugin version. It measures the scheduling rule, not a released old build.
- All arms load the same plugin checkout (`--plugin-dir`) so the environment is identical; the `single` arm's prompt tells it not to use the plugin, and it has no superagent run or metrics.
