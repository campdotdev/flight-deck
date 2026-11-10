// The `flight-deck` binary's entry (overview, "The programs"). `bun build --compile` compiles this file. It
// runs from `versions/<version>/bin/flight-deck`, so the version folder is the binary's grandparent.
import { basename, dirname, resolve } from "node:path";
import { macFolders, type Folders } from "../folders/index.ts";
import { readConfig } from "../install/index.ts";
import { startRunner } from "../runner/index.ts";
import { State } from "../state/index.ts";
import { runCommand } from "./commands.ts";
import { PRODUCTION_ADAPTERS, PRODUCTION_RUNNER } from "./production.ts";

/** The version string the build script stamps with `--define`, such as `0.1.0-dev.20261101T103012Z`. */
declare const FLIGHT_DECK_VERSION: string | undefined;

export async function main(argv: string[]): Promise<number> {
  const folders = macFolders();
  const versionFolder = resolve(dirname(process.execPath), "..");
  // A binary in `versions/<version>/` is that version, as a hand run reads it from `current`'s target.
  const version = typeof FLIGHT_DECK_VERSION === "string" ? FLIGHT_DECK_VERSION : basename(versionFolder);
  if (argv[0] === "runner") return runner(folders, version, versionFolder);
  return runCommand(argv, {
    folders,
    version,
    versionFolder,
    clock: () => new Date(),
    out: (line) => void process.stdout.write(`${line}\n`),
    err: (line) => void process.stderr.write(`${line}\n`),
    adapters: PRODUCTION_ADAPTERS,
  });
}

/**
 * `flight-deck runner`, as the launcher runs it. It runs until SIGTERM, which launchd sends at logout, shutdown,
 * and `bootout`. A failure before the runner opens its log goes to stderr, which the LaunchAgent sends to
 * `state/launchd.log`.
 */
async function runner(folders: Folders, version: string, versionFolder: string): Promise<number> {
  const config = await readConfig(folders);
  const harness = PRODUCTION_RUNNER.harness({ config });
  const running = await startRunner({
    folders,
    version,
    versionFolder,
    tracker: PRODUCTION_RUNNER.runnerTracker({ folders, config }),
    harness,
    closeHarness: async () => harness.close?.(),
  });
  return new Promise((done) => {
    const stop = () => {
      running.terminate().then(
        () => done(0),
        async (error: unknown) => {
          await new State(folders).log(new Date(), `SIGTERM failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
          done(1);
        },
      );
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
