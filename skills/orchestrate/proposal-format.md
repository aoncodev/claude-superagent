# Plan JSON: format and worked example

Write the plan to `.superagent/drafts/<run-id>/plan.json` and run `superagent propose <that path>`. It validates the plan, stores the Charter and tickets, and prints the split proposal.

## Schema

```js
Plan = {
  title: string,
  charter: {
    idea: string,              // the user's words, VERBATIM: never paraphrased, trimmed or tidied
    in_scope: string[],        // short lines drawn from the idea
    out_of_scope: string[],    // what the idea does not ask for, and nearby things to keep out
    allowed_actions: ("push"|"deploy"|"publish"|"production")[]  // only what the user asked for; usually []
  },
  project: {
    kind: "existing"|"new",
    stack: string|null,        // for "new": the proposed stack, matching anything the idea states
    setup: string[],           // e.g. install commands; run in every worktree and on the integration branch
    checks: string[],          // parallel-safe: unit tests, typecheck, lint, builds; no shared DB, fixed ports or services
    integration_checks: string[] // run once on the integration branch after the last wave: e2e, real DB, services
  },
  shared_files?: string[],     // repo-relative files many tickets would touch: manifests, lockfiles, root config, CI files
  contracts: { id: string /* C1, C2… */, title: string, path: string /* repo-relative file */ }[],
  tickets: {
    id: string,                // T1, T2…
    title: string,
    kind: "scaffold"|"contracts"|"work"|"fix",
    wave: number,              // integer >= 0; waves run in ascending order
    scope: string,             // the outcome, not the steps; 1–3 lines
    owns: string[],            // repo-relative paths: a file, or a directory ending in "/"; never globs
    reads: string[],           // read-only context paths
    contracts: string[],       // contract ids this ticket depends on (or produces, for the contracts ticket)
    done_when: string[],       // observable, parallel-safe checks
    depends_on?: string[],     // ticket ids that must be merged before this ticket launches; default []
    model?: string             // worker model for this ticket; omit to use the config's worker_model
  }[],
  parallelism?: number         // 1–8; omit to use config (default 4)
}
```

`superagent add-ticket --origin handback|fix|fidelity --file <ticket.json>` takes one object of the same ticket shape.

## Rules `propose` enforces

- ids match `T<n>` / `C<n>` and are unique; every ticket contract id exists in `contracts`.
- `owns` is non-empty, repo-relative, no `*` or `?`.
- Tickets in the same wave never have overlapping `owns` (`api/` overlaps `api/src/x.ts`).
- A `scaffold` ticket is only allowed when `project.kind` is `"new"`, and it is alone in its wave. A `"new"` project has exactly one scaffold ticket, in the lowest wave.
- Every `work` and `fix` ticket's wave is strictly greater than every `contracts` ticket's wave.
- `allowed_actions` only from push, deploy, publish, production.
- `shared_files`: repo-relative paths (no globs, no duplicates). Every one is owned by a `scaffold` or `contracts` ticket, and **no `work` or `fix` ticket owns one**.
- `depends_on`: ticket ids that exist in the plan; no self-reference, no duplicates, no cycles, and a dependency's wave is at most the ticket's wave. `superagent next` launches a ticket only once its `depends_on` tickets are `merged`; a ticket without `depends_on` also waits for every lower wave to merge.
- `model`: a non-empty string when present. It is the worker model for that ticket; omit it to use the config's `worker_model`.

## Rules for a good split (not enforced; follow them)

- Contracts first: API description, schema, shared types, env var names, folder layout. Name each contract file in `contracts`, and have one contracts ticket write them.
- Shared files (manifests, lockfiles, root config, route registries, CI workflow files) belong to the scaffold or contracts ticket, and every one goes in `shared_files`. The scaffold installs every dependency the plan needs up front, so later tickets never touch the manifest or lockfile. If later tickets plug into a registry, the contracts ticket registers stubs they then own.
- `depends_on` only for real ordering edges. Otherwise put work in the same wave so it runs in parallel; the wave barrier already covers "after the previous wave".
- Set `model` only where the ticket's difficulty or cost justifies a different model from `worker_model`.
- `done_when` uses only parallel-safe checks. Anything needing running services or a real database goes in `project.integration_checks`.
- Aim for about 5–12 tickets.

## Worked example

Idea (empty folder): "Build a small bookmarks web app: a page where I can save a link (URL + title) and see all saved links, newest first. Store them in SQLite. Add a GitHub Actions CI job that runs the tests on every push."

Waves: 0 scaffold (which also owns the CI workflow, a shared file, and installs every dependency up front), 1 contracts, 2 migration + frontend page in parallel, 3 backend endpoint + integration test in parallel. T3 and T4 declare `depends_on: ["T2"]` instead of relying on the wave barrier alone; T5 sets `model` for a heavier ticket. The scaffold owns every entry in `shared_files`.

```json
{
  "title": "Bookmarks app",
  "charter": {
    "idea": "Build a small bookmarks web app: a page where I can save a link (URL + title) and see all saved links, newest first. Store them in SQLite. Add a GitHub Actions CI job that runs the tests on every push.",
    "in_scope": [
      "A page to save a link with a URL and a title",
      "The same page lists all saved links, newest first",
      "Links are stored in SQLite",
      "A GitHub Actions CI job runs the tests on every push"
    ],
    "out_of_scope": [
      "User accounts or login",
      "Editing or deleting links",
      "Deployment"
    ],
    "allowed_actions": []
  },
  "project": {
    "kind": "new",
    "stack": "TypeScript; pnpm workspace; Fastify API in api/; React + Vite page in web/; SQLite via better-sqlite3; Vitest",
    "setup": ["pnpm install"],
    "checks": ["pnpm -r typecheck", "pnpm -r test"],
    "integration_checks": ["pnpm -r build", "pnpm --filter api test:integration"]
  },
  "shared_files": ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", ".github/workflows/ci.yml"],
  "contracts": [
    { "id": "C1", "title": "HTTP API: GET and POST /api/bookmarks", "path": "contracts/openapi.yaml" },
    { "id": "C2", "title": "Shared Bookmark types", "path": "contracts/types.ts" },
    { "id": "C3", "title": "bookmarks table schema", "path": "contracts/schema.sql" },
    { "id": "C4", "title": "Environment variables (DATABASE_PATH)", "path": "contracts/env.md" }
  ],
  "tickets": [
    {
      "id": "T1", "title": "Workspace scaffold and CI", "kind": "scaffold", "wave": 0,
      "scope": "A pnpm workspace with an api package (Fastify, better-sqlite3) and a web package (React + Vite), with every dependency the plan needs installed and locked, typecheck, test and build scripts, and one passing test each; api also has a test:integration script for api/test/integration/, kept out of the plain test run. A GitHub Actions workflow runs pnpm install, pnpm -r typecheck and pnpm -r test on every push.",
      "owns": ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", ".gitignore", ".github/workflows/ci.yml", "api/", "web/"],
      "reads": [], "contracts": [],
      "done_when": ["pnpm install succeeds", "pnpm -r typecheck passes", "pnpm -r test passes", "the workflow parses as YAML and runs exactly the project's setup and check commands"]
    },
    {
      "id": "T2", "title": "Contracts and route stubs", "kind": "contracts", "wave": 1,
      "scope": "The API, shared types, table schema and env var names are written in contracts/. The API registers the bookmarks routes from api/src/bookmarks/ and the web App renders the page from web/src/bookmarks/, both as compiling stubs.",
      "owns": ["contracts/", "api/src/routes.ts", "api/src/bookmarks/", "web/src/App.tsx", "web/src/bookmarks/"],
      "reads": ["api/", "web/"], "contracts": ["C1", "C2", "C3", "C4"],
      "done_when": ["pnpm -r typecheck passes", "pnpm -r test passes"]
    },
    {
      "id": "T3", "title": "SQLite migration", "kind": "work", "wave": 2,
      "scope": "A migration creates the bookmarks table exactly as in contracts/schema.sql, and api/src/db.ts opens the database at DATABASE_PATH and applies pending migrations.",
      "owns": ["api/migrations/", "api/src/db.ts"],
      "reads": ["contracts/"], "contracts": ["C3", "C4"],
      "depends_on": ["T2"],
      "done_when": ["pnpm --filter api test passes, including a test that migrates an in-memory database"]
    },
    {
      "id": "T4", "title": "Bookmarks page", "kind": "work", "wave": 2,
      "scope": "The page has a form (URL, title) that saves through POST /api/bookmarks and lists bookmarks from GET /api/bookmarks, newest first.",
      "owns": ["web/src/bookmarks/"],
      "reads": ["contracts/", "web/src/App.tsx"], "contracts": ["C1", "C2"],
      "depends_on": ["T2"],
      "done_when": ["pnpm --filter web typecheck passes", "pnpm --filter web test passes, with the API mocked"]
    },
    {
      "id": "T5", "title": "Bookmarks API endpoints", "kind": "work", "wave": 3,
      "scope": "GET /api/bookmarks returns all bookmarks newest first and POST /api/bookmarks saves one, rejecting a missing url or title, as contracts/openapi.yaml describes.",
      "owns": ["api/src/bookmarks/"],
      "reads": ["contracts/", "api/src/db.ts", "api/migrations/"], "contracts": ["C1", "C2", "C3"],
      "model": "opus",
      "done_when": ["pnpm --filter api test passes, with handler tests against an in-memory database"]
    },
    {
      "id": "T6", "title": "API integration test", "kind": "work", "wave": 3,
      "scope": "An integration test starts the API on a random port with a temporary database file and checks that a saved bookmark comes back first from GET /api/bookmarks.",
      "owns": ["api/test/integration/"],
      "reads": ["contracts/"], "contracts": ["C1", "C4"],
      "done_when": ["pnpm --filter api typecheck passes (the test itself runs in integration_checks)"]
    }
  ],
  "parallelism": 4
}
```
