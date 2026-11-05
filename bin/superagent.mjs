#!/usr/bin/env node
// superagent CLI dispatcher. Works run directly (`node bin/superagent.mjs`) and
// when imported by the extensionless `bin/superagent` shim, so main() runs unconditionally.
//
// To add a command group: create lib/commands/<group>.mjs exporting a map of
// name -> handler(args, ctx), then add one line to GROUPS below.
// A handler may set `handler.booleans = ['flag', ...]` to declare value-less flags.
import { UsageError } from '../lib/errors.mjs';
import { parseArgs, makeContext } from '../lib/cli.mjs';
import runCommands from '../lib/commands/run.mjs';
import planCommands from '../lib/commands/plan.mjs';
import ticketCommands from '../lib/commands/ticket.mjs';
import mergeCommands from '../lib/commands/merge.mjs';
import reviewCommands from '../lib/commands/review.mjs';

const GROUPS = [
  runCommands,
  planCommands,
  ticketCommands,
  mergeCommands,
  reviewCommands,
];

async function main(argv) {
  const commands = Object.assign({}, ...GROUPS);
  const [name, ...rest] = argv;
  if (!name) throw new UsageError(`usage: superagent <command> [options]\ncommands: ${Object.keys(commands).sort().join(', ')}`);
  const handler = commands[name];
  if (!handler) throw new UsageError(`unknown command: ${name}\ncommands: ${Object.keys(commands).sort().join(', ')}`);
  const args = parseArgs(rest, handler.booleans ?? []);
  await handler(args, makeContext(process.cwd()));
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`superagent: ${e.message}\n`);
  process.exitCode = e.exitCode ?? 2;
}
