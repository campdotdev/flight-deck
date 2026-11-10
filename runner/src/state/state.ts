// State keeps the runner's files in the data folder. Each kind has a typed read and write, every file is
// JSON, and every write is one atomic rename (spec 1, "State").
import { paths, type Folders } from "../folders/index.ts";
import type { RepoRecord, Role } from "../record/index.ts";
import { readdir, rm } from "node:fs/promises";
import { appendLine, readJson, writeJson } from "./files.ts";
import type { RateLimitEvent } from "../harness/index.ts";
import type { HoldCause, Status } from "./status.ts";
import type { TroubleEntry } from "./trouble.ts";

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
  /**
   * Why the runner asked the Harness to stop the session, once it has: `stop` for `flight-deck stop`, and
   * `moved_out` for an issue that left its working status. The `stopped` exit reads it.
   */
  stop_cause?: StopCause;
  /** The app's port, which `prepare` gave the session, for a repo with an app. Absent or `null` otherwise. */
  port?: number | null;
  /** An `apply_waiting` entry's tries. Absent on every other entry. */
  apply?: ApplyWait;
}

/**
 * The tries of an outbox Linear didn't take (spec 1, "Not yet written"). The runner applies it again at the
 * next poll, then after 1, 2, 4, and 8 minutes, then every 15 minutes, with no session.
 */
export interface ApplyWait {
  /** The folder whose outbox the runner applies: the session folder, or the kept folder for a kept outbox's take. */
  folder: string;
  /** `apply`: the status move hasn't landed. `after_move`: it has, and the stage handed off. `pause`: the outbox is kept, and the Linear-write pause hasn't landed. */
  phase: "apply" | "after_move" | "pause";
  /** ISO time of the first try. Three hours from here, the runner keeps the outbox, or drops the writes after the move. */
  since: string;
  /** ISO time of the last try. */
  tried_at: string;
  /** The tries so far in this phase. */
  tries: number;
}

export type StopCause = "stop" | "moved_out";

/** One answer a pause offers (ADR 0019). */
export interface Answer {
  /** One lowercase word. */
  word: string;
  /** What the answer does. */
  does: string;
  /** The role the answer moves the issue to. */
  move: Role;
}

/** Why the runner flagged an issue: a pause, a stale take, or a trouble issue it filed. */
export type FlagCause = "pause" | "stale_take" | "trouble";

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
  /** No try before this ISO time, for a comment that keeps its own backoff, such as the Linear-write pause. */
  not_before?: string;
  /** The issue's identifier, title, and URL, for the flag. */
  issue: string;
  title: string;
  url: string;
}

/**
 * Why the runner put an issue back in its queue without using the stage's retry: a plan limit, an expired
 * login, a failed Reader mint, or a shutdown (spec 1, "Exits"). Each ticket that requeues adds its exit here.
 */
export type RestartCause = "rate_limited" | "login_expired";

/** The next take keeps this attempt, because the requeue that set it used no retry (ADR 0002). */
export interface Restart {
  attempt: number;
  after: RestartCause;
}

/** One issue's memory, keyed by Linear's UUID. Later tickets add more. */
export interface IssueMemory {
  /** The brief the runner last wrote for the issue, or `null`. */
  brief: string | null;
  /** The current flag, or `null`. */
  flag: Flag | null;
  /** The open pause, or `null`. */
  pause: OpenPause | null;
  /** A runner comment Linear didn't take yet, or `null`. */
  pending: PendingComment | null;
  /**
   * The `status_since` of the stay in a working status the runner last flagged as a stale take, or `null`. The
   * issue gets one stale-take flag per stay (ADR 0011).
   */
  stale_take: string | null;
  /** The attempt the next take keeps, set when the runner requeued the issue, or `null` for attempt 1. */
  restart: Restart | null;
  /** The outbox the runner kept after Linear didn't take it for 3 hours, which the next take applies, or `null`. */
  kept: KeptOutbox | null;
}

/**
 * The hold marker, `state/hold`: the one record of the `maintainer` and `stop` holds (spec 1, "State", ADR 0024).
 * `by` tells a hold from a stop.
 */
export interface HoldMarker {
  by: "hold" | "stop";
  /** ISO time. */
  since: string;
}

/** A kept outbox, in `repos/<owner>/<repo>/kept/<issue UUID>/` (spec 1, "Not yet written"). */
export interface KeptOutbox {
  /** The session that wrote it. */
  session: string;
  /** ISO time it was kept. */
  at: string;
}

/** The last valid record the runner read on a repo's default branch, for the stale-take limits (spec 1, "Poll"). */
export interface LastRecord {
  /** The default branch's commit it was read at. */
  commit: string;
  /** ISO time of the read. */
  read_at: string;
  record: RepoRecord;
}

/**
 * The pause the runner posted when a single-instance app's port was in use (spec 1's "Starts", ADR 0003). The
 * repo's other queued issues wait until that pause's `retry` or a free port.
 */
export interface PortPause {
  /** The paused issue's UUID and identifier. */
  issue: string;
  identifier: string;
  port: number;
  /** ISO time of the pause. */
  at: string;
}

/**
 * `state/trial.json`: the last trial run that passed, with the Flight Deck version it ran on. Install's trial
 * step is done when it names the running version (spec 1, "Install").
 */
export interface TrialPass {
  version: string;
  claude_code_version: string;
  session: string;
  /** ISO time. */
  passed_at: string;
}

const EMPTY_MEMORY: IssueMemory = { brief: null, flag: null, pause: null, pending: null, stale_take: null, restart: null, kept: null };

/** One hold `state/holds.json` keeps: a usage hold, with when it ends (spec 1, "Holds"). */
export interface StoredHold {
  cause: HoldCause;
  /** ISO time. */
  since: string;
  /** ISO time it ends on its own. */
  until: string;
}

/** `state/holds.json`: the usage holds, and the latest `rate_limit_event` beside them. */
export interface Holds {
  holds: StoredHold[];
  rate_limit_event: RateLimitEvent | null;
}

/** `state/spend.json`: on an API key, the day's and the month's spending, in the Mac's time zone. */
export interface Spend {
  /** The local day the spending is for, `YYYY-MM-DD`. */
  day: string;
  day_usd: number;
  /** The local month, `YYYY-MM`. */
  month: string;
  month_usd: number;
}

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

  /** The hold marker, or `null` while neither `hold` nor `stop` holds the runner. */
  async holdMarker(): Promise<HoldMarker | null> {
    return readJson<HoldMarker | null>(paths.holdMarker(this.folders), null);
  }

  /** Writes the hold marker, or removes it for `null`. */
  async writeHoldMarker(marker: HoldMarker | null): Promise<void> {
    if (marker === null) await rm(paths.holdMarker(this.folders), { force: true });
    else await writeJson(paths.holdMarker(this.folders), marker);
  }

  async holds(): Promise<Holds> {
    return { holds: [], rate_limit_event: null, ...(await readJson<Partial<Holds>>(paths.holds(this.folders), {})) };
  }

  async writeHolds(holds: Holds): Promise<void> {
    await writeJson(paths.holds(this.folders), holds);
  }

  /** The spending on record, or `null` before the first session on an API key ends. */
  async spend(): Promise<Spend | null> {
    return readJson<Spend | null>(paths.spend(this.folders), null);
  }

  async writeSpend(spend: Spend): Promise<void> {
    await writeJson(paths.spend(this.folders), spend);
  }

  /** The last valid record the runner read for the repo, or `null` when it never read one. */
  async lastRecord(repo: string): Promise<LastRecord | null> {
    return readJson<LastRecord | null>(paths.lastRecord(this.folders, repo), null);
  }

  async writeLastRecord(repo: string, last: LastRecord): Promise<void> {
    await writeJson(paths.lastRecord(this.folders, repo), last);
  }

  /** The repo's open port pause, or `null`. */
  async portPause(repo: string): Promise<PortPause | null> {
    return readJson<PortPause | null>(paths.portPause(this.folders, repo), null);
  }

  /** Writes the repo's open port pause, or removes it for `null`. */
  async writePortPause(repo: string, pause: PortPause | null): Promise<void> {
    if (pause === null) await rm(paths.portPause(this.folders, repo), { force: true });
    else await writeJson(paths.portPause(this.folders, repo), pause);
  }

  /** The last trial run that passed, or `null` before one did. */
  async trial(): Promise<TrialPass | null> {
    return readJson<TrialPass | null>(paths.trial(this.folders), null);
  }

  async writeTrial(pass: TrialPass): Promise<void> {
    await writeJson(paths.trial(this.folders), pass);
  }

  /** `state/trouble.json`: each trouble cause the runner knows, open or cleared with its issue still open. */
  async trouble(): Promise<TroubleEntry[]> {
    return readJson<TroubleEntry[]>(paths.trouble(this.folders), []);
  }

  async writeTrouble(entries: TroubleEntry[]): Promise<void> {
    await writeJson(paths.trouble(this.folders), entries);
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
