// A command line over a scenario's world: `flight-deck <command>` as the maintainer types it, with the
// world's folders and clock, and its output kept for the test to read.
import { runCommand, type Adapters } from "../../src/cli/index.ts";
import { listenRunnerSocket, type RunnerSocket } from "../../src/runner/index.ts";
import type { World } from "../scenario/world.ts";

export interface Cli {
  /** Runs one command and returns its exit code. */
  run(...argv: string[]): Promise<number>;
  /** Every line the commands printed to stdout, in order. */
  out: string[];
  /** Every line the commands printed to stderr, in order. */
  err: string[];
}

/** The commands, with the in-memory Tracker for any Linear identity the command asks for. */
export function cli(world: World, adapters: Partial<Adapters> = {}): Cli {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    run: (...argv) =>
      runCommand(argv, {
        folders: world.folders,
        version: world.version,
        versionFolder: world.versionFolder,
        clock: () => world.now,
        out: (line) => void out.push(line),
        err: (line) => void err.push(line),
        answerMs: 2_000,
        adapters: {
          maintainerTracker: () => world.tracker.as(world.maintainer.id),
          ...adapters,
        },
      }),
  };
}

/** The runner's socket over the world's Poll, as `flight-deck runner` listens on it. */
export function listen(world: World): Promise<RunnerSocket> {
  return listenRunnerSocket({ folders: world.folders, poll: world.poll, clock: () => world.now });
}
