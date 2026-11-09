#!/usr/bin/env node
// PreToolUse guard for Bash. See lib/guard.mjs for the rules.
import { decideBash } from '../lib/guard.mjs';
import { inLinkedWorktree } from '../lib/git.mjs';
import { activeRunId, loadRun, readConfig } from '../lib/state.mjs';
import { runGuard } from './guard-common.mjs';

const WORKER_AGENT_TYPES = new Set(['superagent:worker', 'superagent:fidelity-reviewer']);

await runGuard(({ payload, root }) => {
  const command = payload.tool_input?.command;
  if (typeof command !== 'string' || command === '') return { allow: true };

  let run = null;
  let config = { production_markers: [] };
  let warning = null;
  try {
    const id = activeRunId(root);
    if (id) run = loadRun(root, id);
  } catch (e) {
    // Unloadable run: fail open, but the always-on protection of .superagent/runs/ still applies.
    run = null;
    warning = e?.message ?? String(e);
  }
  try {
    config = readConfig(root);
  } catch (e) {
    // Unreadable config: keep blocking outward actions, with default (empty) production markers.
    warning = warning ?? `config.json unreadable: ${e?.message ?? e}`;
  }
  // A worker or reviewer subagent: by agent type, or by working inside a linked worktree.
  let fromWorker = WORKER_AGENT_TYPES.has(payload.agent_type);
  if (!fromWorker) {
    try {
      fromWorker = inLinkedWorktree(payload.cwd);
    } catch {
      fromWorker = false;
    }
  }
  const d = decideBash({
    command,
    run,
    config,
    fromWorker,
    reviewer: payload.agent_type === 'superagent:fidelity-reviewer',
    mainRoot: root,
  });
  return warning ? { ...d, warning } : d;
});
