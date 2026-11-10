// The contract rig's stand-in for `<version folder>/bin/flight-deck`, which a session's `headersHelper` runs. It
// runs the real `linear-token` command against the rig's own data folder, whose `state/runner.sock` the rig
// answers. The first argument is that data folder, because the helper may not see any environment.
import { homedir } from "node:os";
import { join } from "node:path";
import { linearTokenCommand } from "../../../src/cli/credentials.ts";
import type { CommandContext } from "../../../src/cli/context.ts";

const [data, command, ...argv] = process.argv.slice(2);
if (data === undefined || command !== "linear-token") {
  process.stderr.write("Usage: flight-deck.ts <data folder> linear-token <session-id>\n");
  process.exit(64);
}

const context: CommandContext = {
  folders: { data, config: join(data, "config"), sessionRoot: join(data, "unused"), home: homedir() },
  version: "contract",
  versionFolder: join(data, "versions", "contract"),
  clock: () => new Date(),
  out: (line) => void process.stdout.write(`${line}\n`),
  err: (line) => void process.stderr.write(`${line}\n`),
  prompt: {
    secret: () => {
      throw new Error("the contract rig's flight-deck runs only linear-token");
    },
    ask: () => {
      throw new Error("the contract rig's flight-deck runs only linear-token");
    },
  },
  cwd: process.cwd(),
  env: process.env,
  adapters: {
    maintainerTracker: () => {
      throw new Error("the contract rig's flight-deck runs only linear-token");
    },
    appTracker: () => {
      throw new Error("the contract rig's flight-deck runs only linear-token");
    },
  },
  shell: {
    run: () => {
      throw new Error("the contract rig's flight-deck runs only linear-token");
    },
    open: () => {
      throw new Error("the contract rig's flight-deck runs only linear-token");
    },
    sleep: (ms) => Bun.sleep(ms),
    uid: 0,
  },
};
process.exit(await linearTokenCommand(argv, context));
