// A command line over a scenario's world: `flight-deck <command>` as the maintainer types it, with the
// world's folders and clock, and its output kept for the test to read.
import { runCommand, type Adapters } from "../../src/cli/index.ts";
import { Canceled, type Prompt } from "../../src/cli/prompt.ts";
import type { Folders } from "../../src/folders/index.ts";
import { listenRunnerSocket, type RunnerSocket } from "../../src/runner/index.ts";
import type { World } from "../scenario/world.ts";

export interface Cli {
  /** Runs one command and returns its exit code. */
  run(...argv: string[]): Promise<number>;
  /** Every line the commands printed to stdout, in order. */
  out: string[];
  /** Every line the commands printed to stderr, in order. */
  err: string[];
  /** Every question a hidden prompt asked, in order. */
  asked: string[];
  /** The answers the hidden prompts still have to give, in order. Push more before a run. */
  answers: string[];
}

export interface CliOptions {
  folders: Folders;
  clock: () => Date;
  adapters: Adapters;
  version?: string;
  versionFolder?: string;
  /** The folder the command runs in. */
  cwd?: string;
  /** The command's environment. */
  env?: Record<string, string | undefined>;
  /** Where `register` clones a repo from, in place of GitHub. */
  remoteOf?: (repo: string) => string;
}

/** The commands over any folders, with a hidden prompt that gives each answer in turn. */
export function cliAt(options: CliOptions): Cli {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const answers: string[] = [];
  const prompt: Prompt = {
    secret: async (question) => {
      asked.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Canceled();
      return answer;
    },
  };
  return {
    out,
    err,
    asked,
    answers,
    run: (...argv) =>
      runCommand(argv, {
        folders: options.folders,
        version: options.version ?? "0.1.0",
        versionFolder: options.versionFolder ?? "/nonexistent",
        clock: options.clock,
        out: (line) => void out.push(line),
        err: (line) => void err.push(line),
        prompt,
        cwd: options.cwd ?? "/nonexistent",
        env: options.env ?? { PATH: "/usr/bin:/bin" },
        ...(options.remoteOf === undefined ? {} : { remoteOf: options.remoteOf }),
        answerMs: 2_000,
        adapters: options.adapters,
      }),
  };
}

/** The commands, with the in-memory Tracker for any Linear identity the command asks for. */
export function cli(world: World, adapters: Partial<Adapters> = {}, options: Partial<CliOptions> = {}): Cli {
  return cliAt({
    folders: world.folders,
    clock: () => world.now,
    version: world.version,
    versionFolder: world.versionFolder,
    remoteOf: () => world.remote,
    ...options,
    adapters: {
      maintainerTracker: () => world.tracker.as(world.maintainer.id),
      appTracker: () => world.tracker,
      ...adapters,
    },
  });
}

/** The runner's socket over the world's Poll, as `flight-deck runner` listens on it. */
export function listen(world: World): Promise<RunnerSocket> {
  return listenRunnerSocket({ folders: world.folders, poll: world.poll, clock: () => world.now });
}
