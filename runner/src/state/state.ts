// State keeps the runner's files in the data folder. Each kind has a typed read and write, every file is
// JSON, and every write is one atomic rename (spec 1, "State").
import { paths, type Folders } from "../folders/index.ts";
import type { Role } from "../record/index.ts";
import { readdir } from "node:fs/promises";
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

/** One answer a pause offers (ADR 0019). */
export interface Answer {
  /** One lowercase word. */
  word: string;
  /** What the answer does. */
  does: string;
  /** The role the answer moves the issue to. */
  move: Role;
}

/** Why the runner flagged an issue. Later tickets add stale takes and trouble issues. */
export type FlagCause = "pause";

/** The runner's flag on an issue: it assigned the maintainer (ADR 0011). */
export interface Flag {
  cause: FlagCause;
  /** The flag comment's status line, for `status.json`. */
  status_line: string;
  /** ISO time. */
  since: string;
  /** The issue's identifier, title, and URL when it was flagged, for `status.json`. */
  issue: string;
  title: string;
  url: string;
}

/** A comment posted after a pause comment, with the body the first snapshot that saw it returned. */
export interface Reply {
  id: string;
  /** The author's user ID. */
  author: string;
  created_at: string;
  body: string;
  /** Whether it came through the GitHub sync. */
  synced: boolean;
}

/** An open pause: its answers and when its comment landed. */
export interface OpenPause {
  answers: Answer[];
  /** The pause comment's creation time. Only later comments can answer it. */
  comment_at: string;
  /** Every comment posted after the pause comment that a snapshot has returned so far. */
  replies: Reply[];
}

/**
 * A runner comment Linear didn't take yet, with the writes that go with it (spec 1, "The runner's own
 * comments"). The runner tries it again at each poll, and nothing else happens to the issue until it lands.
 */
export interface PendingComment {
  body: string;
  /** The comment's status line, for the flag. */
  status_line: string;
  /** The flag's cause, or `null` for a comment that flags no one, such as the stop pause. */
  flag: FlagCause | null;
  /** For a pause: the role it moves the issue from, and its answers. `null` for a comment that moves nothing. */
  pause: { from: Role; answers: Answer[] } | null;
  /** The writes that landed so far, in order: `post`, then `move`. */
  landed: ("post" | "move")[];
  /** The comment's creation time, once `post` landed. */
  comment_at: string | null;
  /** ISO time of the last try. */
  tried_at: string;
  /** The issue's identifier, title, and URL, for the flag. */
  issue: string;
  title: string;
  url: string;
}

/** One issue's memory, keyed by Linear's UUID. Later tickets add the attempt and more. */
export interface IssueMemory {
  /** The brief the runner last wrote for the issue, or `null`. */
  brief: string | null;
  /** The current flag, or `null`. */
  flag: Flag | null;
  /** The open pause, or `null`. */
  pause: OpenPause | null;
  /** A runner comment Linear didn't take yet, or `null`. */
  pending: PendingComment | null;
}

const EMPTY_MEMORY: IssueMemory = { brief: null, flag: null, pause: null, pending: null };

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

  /** Every issue memory the repo holds, by issue UUID. */
  async issueMemories(repo: string): Promise<{ uuid: string; memory: IssueMemory }[]> {
    const names = await readdir(paths.issues(this.folders, repo)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const uuids = names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length)).sort();
    return Promise.all(uuids.map(async (uuid) => ({ uuid, memory: await this.issueMemory(repo, uuid) })));
  }

  async writeIssueMemory(repo: string, uuid: string, memory: IssueMemory): Promise<void> {
    await writeJson(paths.issueMemory(this.folders, repo, uuid), memory);
  }

  /** Where the repo's last snapshot read comments to: an ISO creation time, or `null` before the first. */
  async cursor(repo: string): Promise<string | null> {
    return (await readJson<{ comments: string | null }>(paths.cursor(this.folders, repo), { comments: null })).comments;
  }

  async writeCursor(repo: string, comments: string): Promise<void> {
    await writeJson(paths.cursor(this.folders, repo), { comments });
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
