// Shared plumbing for the PreToolUse guard hooks: read the payload, find the root, fail open.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mainRoot } from '../lib/git.mjs';
import { stateDir } from '../lib/state.mjs';

export function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

export function emitDeny(reason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  })}\n`);
}

export function warn(message) {
  process.stderr.write(`superagent guard: ${String(message).replace(/\s+/g, ' ')} (allowing)\n`);
}

/**
 * Run a guard. `decide({ payload, root })` returns { allow: true, warning? } or { allow: false, reason }.
 * Any exception, or a warning from `decide`, is reported on stderr and the action is allowed.
 */
export async function runGuard(decide) {
  try {
    const payload = JSON.parse(await readStdin());
    if (payload === null || typeof payload !== 'object' || typeof payload.cwd !== 'string') {
      throw new Error('payload has no cwd');
    }
    let root;
    try {
      root = mainRoot(payload.cwd);
    } catch {
      return; // not a git repo: nothing to guard
    }
    if (!existsSync(stateDir(root))) return;
    const d = await decide({ payload, root, hasActive: existsSync(join(stateDir(root), 'active')) });
    if (!d.allow) emitDeny(d.reason);
    else if (d.warning) warn(d.warning);
  } catch (e) {
    warn(e?.message ?? e);
  }
}
