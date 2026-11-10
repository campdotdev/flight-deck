// The command line (overview, "The command line"): one entry per command spec 1 builds.
import type { CommandContext } from "./context.ts";
import { applyCommand } from "./apply.ts";
import { apiKeyCommand, linearTokenCommand } from "./credentials.ts";
import { holdCommand } from "./holds.ts";
import { installCommand } from "./install.ts";
import { loginCommand } from "./login.ts";
import { registerCommand } from "./register.ts";
import { statusCommand } from "./status.ts";
import { updateCommand } from "./update.ts";

const USAGE =
  "Usage: flight-deck <install | status | hold | start | stop | login github | login linear <workspace> | register <owner/repo> | apply [--dry-run] <folder> | update --from <folder> | linear-token <session-id> | api-key | runner>";

/** Runs one command, and returns its exit code. */
export async function runCommand(argv: string[], context: CommandContext): Promise<number> {
  const [command] = argv;
  switch (command) {
    case "hold":
    case "start":
    case "stop":
      return holdCommand(command, context);
    case "install":
      return installCommand(argv.slice(1), context);
    case "update":
      return updateCommand(argv.slice(1), context);
    case "status":
      return statusCommand(context);
    case "login":
      return loginCommand(argv.slice(1), context);
    case "register":
      return registerCommand(argv.slice(1), context);
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
