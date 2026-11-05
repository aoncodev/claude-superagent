#!/usr/bin/env node
// PreToolUse guard for Bash. See lib/guard.mjs for the rules.
import { decideBash } from '../lib/guard.mjs';
import { activeRunId, loadRun, readConfig } from '../lib/state.mjs';
import { runGuard } from './guard-common.mjs';

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
  const d = decideBash({ command, run, config });
  return warning ? { ...d, warning } : d;
});
