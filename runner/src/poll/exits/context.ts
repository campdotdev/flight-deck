// What an exit handler gets: the session's entry and exit, the ports, and the steps every handler shares
// (spec 1, "Exits"). The Poll builds one context per exit at the start of the next tick.
import type { Exit } from "../../harness/index.ts";
import type { Config } from "../../install/index.ts";
import type { ApplyResult } from "../../outbox/index.ts";
import type { FailedExit } from "../../outbox/runner-comments/failed-twice.ts";
import type { RunnerFacts, RunnerText } from "../../outbox/runner-comments/index.ts";
import type { SessionEntry, State } from "../../state/index.ts";
import type { Tracker, TrackerRepo } from "../../tracker/index.ts";
import type { Workspace } from "../../workspace/index.ts";

export interface ExitContext {
  now: Date;
  entry: SessionEntry;
  exit: Exit;
  /** `config.toml`, as this tick read it. */
  config: Config;
  repo: TrackerRepo;
  /** The Tracker adapter, as the Flight Deck app. */
  tracker: Tracker;
  state: State;
  workspace: Workspace;
  sessionFolder: string;
  /** The session's facts for a runner comment's Details fold: the exit, session ID, attempt, transcript, and error. */
  facts: RunnerFacts;
  /** Applies the session's outbox as the Flight Deck app. */
  apply(): Promise<ApplyResult>;
  /** The session is over: dispose its workspace and remove its entry. */
  finish(): Promise<void>;
  /** A failed session: dispose its workspace, then the first failure waits as `retry_waiting`, and a second pauses the issue. */
  fail(failure: FailedExit): Promise<void>;
  /** Dispose the workspace, remove the entry, and pause the issue with a runner comment, using no retry. */
  pause(text: RunnerText): Promise<void>;
  /** One line in the runner's log, after the session ID and the issue. */
  log(message: string): Promise<void>;
}

/** What the runner does after one kind of exit. */
export type ExitHandler = (context: ExitContext) => Promise<void>;
