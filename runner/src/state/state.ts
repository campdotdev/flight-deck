// State keeps the runner's files in the data folder. Each kind has a typed read and write, every file is
// JSON, and every write is one atomic rename (spec 1, "State").
import { paths, type Folders } from "../folders/index.ts";
import { appendLine, readJson, writeJson } from "./files.ts";
import type { Status } from "./status.ts";

export type Stage = "plan" | "build" | "check" | "debrief" | "trial";
export type Mode = "issue" | "sub_issue" | "spec" | "bot_round" | "recheck";
export type SessionState = "starting" | "running" | "retry_waiting" | "apply_waiting" | "shutdown";

/** One entry in the session list (ADR 0002). */
export interface SessionEntry {
  /** The session ID. */
  id: string;
  /** `owner/repo`. */
  repo: string;
  /** The issue's identifier, such as `SHA-12`. */
  issue: string;
  /** Linear's UUID for the issue. */
  issue_id: string;
  /** The issue's title, for `status.json`. */
  title: string;
  stage: Stage;
  mode: Mode;
  attempt: number;
  pid: number | null;
  /** The process's start time, so a reused process ID never matches. */
  pid_started_at: string | null;
  /** The UUID Claude Code got as `--session-id`. */
  claude_uuid: string | null;
  worktree: string;
  started_at: string | null;
  deadline: string | null;
  state: SessionState;
}

/** One issue's memory, keyed by Linear's UUID. Later tickets add the attempt, the flag, the pause, and more. */
export interface IssueMemory {
  /** The brief the runner last wrote for the issue, or `null`. */
  brief: string | null;
}

const EMPTY_MEMORY: IssueMemory = { brief: null };

export class State {
  constructor(private readonly folders: Folders) {}

  async sessions(): Promise<SessionEntry[]> {
    return readJson<SessionEntry[]>(paths.sessionList(this.folders), []);
  }

  async writeSessions(sessions: SessionEntry[]): Promise<void> {
    await writeJson(paths.sessionList(this.folders), sessions);
  }

  async issueMemory(repo: string, uuid: string): Promise<IssueMemory> {
    return { ...EMPTY_MEMORY, ...(await readJson<Partial<IssueMemory>>(paths.issueMemory(this.folders, repo, uuid), {})) };
  }

  async writeIssueMemory(repo: string, uuid: string, memory: IssueMemory): Promise<void> {
    await writeJson(paths.issueMemory(this.folders, repo, uuid), memory);
  }

  /** The time of the last poll, written every poll. */
  async writeHeartbeat(at: Date): Promise<void> {
    await writeJson(paths.heartbeat(this.folders), { at: at.toISOString() });
  }

  /** Writes `status.json`. */
  async publish(status: Status): Promise<void> {
    await writeJson(paths.status(this.folders), status);
  }

  /** One line in the runner's log. */
  async log(at: Date, message: string): Promise<void> {
    await appendLine(paths.log(this.folders), `${at.toISOString()} ${message}`);
  }
}
