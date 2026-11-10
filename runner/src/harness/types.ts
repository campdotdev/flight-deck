// The Harness port: the only module that starts Claude Code (overview, spec 1's "Harness").
import type { Mode, Stage } from "../state/index.ts";

/** What `start` needs to run one session. */
export interface HarnessSession {
  /** The session ID. */
  id: string;
  stage: Stage;
  mode: Mode;
  /** `owner/repo`, or `""` for a trial. */
  repo: string;
  /** The issue's identifier, such as `SHA-12`. The flow's prompt names it. */
  issue: string;
  worktree: string;
  sessionFolder: string;
  /** The path of `session.json`, which `FLIGHT_DECK_SESSION` names. */
  sessionJson: string;
  /** Where the `stream-json` output goes: `repos/<owner>/<repo>/transcripts/<session-id>.jsonl`. */
  transcript: string;
  /** ISO time the stage's time limit ends. */
  deadline: string;
  /** The stage's model from `config.toml`, or `""` for Claude Code's default. */
  model: string;
  /** The exact version folder, never `current` (ADR 0015). */
  versionFolder: string;
}

/** The running session, as the session list records it. */
export interface Handle {
  session: string;
  /** The UUID Claude Code got as `--session-id`. */
  uuid: string;
  pid: number;
  /** The process's start time, so a reused process ID never matches. */
  pidStartedAt: string;
}

/** How a session ended. `stopped` wins over `no_init`, then `timed_out`, `login_expired`, `rate_limited`, `exited`. */
export type ExitKind =
  | { kind: "exited"; code: number }
  | { kind: "rate_limited"; resetsAt: string | null }
  | { kind: "no_init" }
  | { kind: "timed_out" }
  | { kind: "stopped" }
  | { kind: "login_expired" };

/**
 * Every exit names the transcript and the Claude Code version. `error` is the last error message from the
 * session's `result` event, when it had one. A runner comment's Details fold shows it (ADR 0019).
 */
export type Exit = ExitKind & { transcript: string; claudeCodeVersion: string; error?: string };

/** One `rate_limit_event` from the stream. The Harness contract suite's fixtures pin its fields. */
export interface RateLimitEvent {
  [field: string]: unknown;
}

/** What a running session reports. The runner queues each exit and handles it at the next tick. */
export interface SessionEvents {
  exit(exit: Exit): void;
  rateLimit(event: RateLimitEvent): void;
}

export interface Harness {
  /** Starts one session. */
  start(session: HarnessSession, events: SessionEvents): Promise<Handle>;
  /** Asks the session to stop. It ends with `stopped`. */
  stop(handle: Handle): Promise<void>;
  /** The installed Claude Code version. */
  version(): Promise<string>;
}
