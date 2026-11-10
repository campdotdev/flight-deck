// The command line (overview, "The command line"): one entry per command spec 1 builds. `install`, `login`,
// `register`, and `update` come with their own tickets.
import type { CommandContext } from "./context.ts";
import { applyCommand } from "./apply.ts";
import { apiKeyCommand, linearTokenCommand } from "./credentials.ts";
import { holdCommand } from "./holds.ts";
import { statusCommand } from "./status.ts";

const USAGE = "Usage: flight-deck <status | hold | start | stop | apply [--dry-run] <folder> | linear-token <session-id> | api-key | runner>";

/** Runs one command, and returns its exit code. */
export async function runCommand(argv: string[], context: CommandContext): Promise<number> {
  const [command] = argv;
  switch (command) {
    case "hold":
    case "start":
    case "stop":
      return holdCommand(command, context);
    case "status":
      return statusCommand(context);
    case "apply":
      return applyCommand(argv.slice(1), context);
    case "linear-token":
      return linearTokenCommand(argv.slice(1), context);
    case "api-key":
      return apiKeyCommand(context);
    default:
      context.err(command === undefined ? USAGE : `flight-deck has no command ${command}. ${USAGE}`);
      return 64;
  }
}
