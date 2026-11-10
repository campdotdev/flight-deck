// What every command gets: the folders, the running version, the clock, where it prints, and the adapters it
// may build. `main.ts` fills it for the Mac, and tests fill it over a scenario's world.
import type { Folders } from "../folders/index.ts";
import type { Harness } from "../harness/index.ts";
import type { Config } from "../install/index.ts";
import type { Tracker } from "../tracker/index.ts";
import type { Prompt } from "./prompt.ts";
import type { Shell } from "./shell.ts";

/**
 * The production adapters a command builds. The runner gets the Tracker as the Flight Deck app, and
 * `flight-deck apply` gets it as the maintainer, through their setup key (ADRs 0005, 0007, and 0017).
 */
export interface Adapters {
  /** The Tracker as the maintainer, with their setup key for the workspace. */
  maintainerTracker(input: { folders: Folders; workspace: string; setupKey: string }): Tracker;
  /** The Tracker as the Flight Deck app, as the runner builds it, for `register`'s team check. */
  appTracker(input: { folders: Folders }): Tracker;
}

/** The adapters `flight-deck runner` runs on: the Tracker as the Flight Deck app, and the Harness. */
export interface RunnerAdapters {
  runnerTracker(input: { folders: Folders; config: Config }): Tracker;
  /** The Harness, with `close` for what it keeps across sessions, such as `caffeinate`. */
  harness(input: { config: Config }): Harness & { close?(): Promise<void> };
}

export interface CommandContext {
  folders: Folders;
  /** The running version. */
  version: string;
  /** The running version's folder. */
  versionFolder: string;
  clock: () => Date;
  /** Prints one line to stdout. */
  out(line: string): void;
  /** Prints one line to stderr. */
  err(line: string): void;
  /** Reads each secret with echo off. */
  prompt: Prompt;
  /** The folder the command runs in, `register`'s default checkout. */
  cwd: string;
  /** The command's environment, whose `PATH` `register` captures. */
  env: Record<string, string | undefined>;
  /** The URL Flight Deck's clone of a repo fetches from. `https://github.com/<owner>/<repo>.git` by default. */
  remoteOf?: (repo: string) => string;
  adapters: Adapters;
  /** The programs install, `login github`, and `update` run: `launchctl`, `gh`, `claude`, and `open`. */
  shell: Shell;
  /** How long a command waits for the runner's answer before it acts on its own. 10 seconds by default. */
  answerMs?: number;
}

/** How long a command waits for the runner by default, as `flight-deck update` does (spec 1, "Install"). */
export const ANSWER_MS = 10_000;
