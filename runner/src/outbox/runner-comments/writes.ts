// The writes a runner comment makes (spec 1, "The runner's own comments"). A pause makes the same writes as an
// outbox's `paused`, in the same order, and files no follow-up issue: the flag in issue memory, `Tracker.post`
// (flagged, except for the stop pause), `Lifecycle.move(issue, paused)`, then the answers, the comment's time,
// and any reply already posted in issue memory. When Linear doesn't take a write, the comment waits in issue
// memory, and the next poll tries the writes still to land. Nothing else happens to the issue until it lands.
import { Lifecycle } from "../../lifecycle/index.ts";
import type { Role } from "../../record/index.ts";
import type { IssueMemory, PendingComment, Reply, State } from "../../state/index.ts";
import { isUnavailable, type SnapshotIssue, type Tracker, type TrackerComment, type TrackerIssue, type TrackerRepo } from "../../tracker/index.ts";
import { repliesAfter } from "../replies.ts";
import type { RunnerComment } from "./frame.ts";

/** The issue a runner comment goes on, as it stands when the runner writes it. */
export interface RunnerTarget {
  /** Linear's UUID. */
  id: string;
  repo: TrackerRepo;
  identifier: string;
  title: string;
  url: string;
  /** The issue's role now. A pause moves it from here to `paused`. */
  role: Role;
}

export interface RunnerCommentsOptions {
  /** The Tracker adapter, as the Flight Deck app. */
  tracker: Tracker;
  state: State;
  clock: () => Date;
}

/** `landed`: every write landed. `pending`: Linear didn't take one, and the next poll tries again. `dropped`: the issue moved on. */
export type RunnerWriteResult = "landed" | "pending" | "dropped";

export class RunnerComments {
  private readonly tracker: Tracker;
  private readonly lifecycle: Lifecycle;
  private readonly state: State;
  private readonly clock: () => Date;

  constructor(options: RunnerCommentsOptions) {
    this.tracker = options.tracker;
    this.lifecycle = new Lifecycle(options.tracker);
    this.state = options.state;
    this.clock = options.clock;
  }

  /**
   * Records the comment in issue memory, then makes its writes. `extra` holds other issue-memory fields that go in
   * the same write, such as a stale take's stay, so a stop between two writes can't keep one without the other.
   */
  async post(target: RunnerTarget, comment: RunnerComment, extra: Partial<Omit<IssueMemory, "pending">> = {}): Promise<RunnerWriteResult> {
    const now = this.clock().toISOString();
    const pending: PendingComment = {
      body: comment.body,
      status_line: comment.statusLine,
      flag: comment.flag,
      pause: comment.answers === null ? null : { from: target.role, answers: [...comment.answers] },
      landed: [],
      comment_at: null,
      since: now,
      tried_at: now,
      replies: [],
      issue: target.identifier,
      title: target.title,
      url: target.url,
    };
    const memory = await this.state.issueMemory(target.repo.name, target.id);
    await this.state.writeIssueMemory(target.repo.name, target.id, { ...memory, ...extra, pending });
    return this.write(target.repo, target.id, pending, false);
  }

  /**
   * Tries the issue's pending comment again, unless the last try was at this poll or its `not_before` hasn't
   * come. `issue` is the issue as this poll read it, or `null` when the snapshot no longer holds it. When the
   * issue moved before the pause's move landed, the comment is dropped, because the maintainer moved it.
   */
  async retry(repo: TrackerRepo, uuid: string, issue: Pick<SnapshotIssue, "status_since"> & { role: Role | null } | null): Promise<RunnerWriteResult | null> {
    const memory = await this.state.issueMemory(repo.name, uuid);
    let pending = memory.pending;
    const now = this.clock().toISOString();
    if (pending === null) return null;
    if (pending.tried_at >= now || (pending.not_before !== undefined && now < pending.not_before)) return "pending";
    // A move can land without its response. A posted pause whose issue already sits in Paused is that move, as
    // the Outbox reads its own.
    if (pending.pause !== null && pending.landed.includes("post") && !pending.landed.includes("move") && issue?.role === "paused") {
      pending = { ...pending, landed: [...pending.landed, "move"] };
    }
    const moved = pending.pause !== null && !pending.landed.includes("move") && issue?.role !== pending.pause.from;
    // A stale-take comment belongs to the stay it flagged, which issue memory's `stale_take` names. A move ends it.
    const stayEnded = pending.flag === "stale_take" && !pending.landed.includes("post") && issue?.status_since !== memory.stale_take;
    if (issue === null || moved || stayEnded) {
      const flag = pending.landed.includes("post") ? memory.flag : null;
      await this.state.writeIssueMemory(repo.name, uuid, { ...memory, flag, pending: null });
      await this.state.log(this.clock(), `${pending.issue}: moved on, runner comment dropped: ${pending.status_line}`);
      return "dropped";
    }
    const tried = { ...pending, tried_at: this.clock().toISOString() };
    await this.state.writeIssueMemory(repo.name, uuid, { ...memory, pending: tried });
    return this.write(repo, uuid, tried, true);
  }

  /**
   * Makes each write still to land, recording each in issue memory as it lands. `retried` says an earlier try
   * may have posted the comment.
   */
  private async write(repo: TrackerRepo, uuid: string, start: PendingComment, retried: boolean): Promise<RunnerWriteResult> {
    let pending = start;
    const save = async (patch: Partial<PendingComment>) => {
      pending = { ...pending, ...patch };
      const memory = await this.state.issueMemory(repo.name, uuid);
      await this.state.writeIssueMemory(repo.name, uuid, { ...memory, pending });
    };
    const ref = { id: uuid, repo };
    let replies: Reply[] = [];
    try {
      if (!pending.landed.includes("post")) {
        // A post can land without its response. A retry finds the comment an earlier try posted, and keeps its
        // creation time, so a reply to it still answers.
        const posted = retried ? postedComment(await this.tracker.issue(ref), pending) : undefined;
        if (pending.flag !== null && posted === undefined) {
          // The flag goes into issue memory first, so the next poll never takes the assignee for one the runner didn't set.
          const memory = await this.state.issueMemory(repo.name, uuid);
          const flag = { cause: pending.flag, status_line: pending.status_line, since: this.clock().toISOString(), issue: pending.issue, title: pending.title, url: pending.url };
          await this.state.writeIssueMemory(repo.name, uuid, { ...memory, flag });
        }
        const at = posted?.created_at ?? (await this.tracker.post(ref, pending.body, { flag: pending.flag !== null })).created_at;
        await save({ landed: [...pending.landed, "post"], comment_at: at });
      }
      if (pending.pause !== null && !pending.landed.includes("move")) {
        const from = pending.pause.from;
        const moved = await this.lifecycle.move({ ...ref, role: from }, "paused", from === "ready_to_plan" ? "pause_before_take" : "pause");
        if (!moved.ok) {
          await this.state.log(this.clock(), `${pending.issue}: runner pause refused: ${moved.violation}`);
          const memory = await this.state.issueMemory(repo.name, uuid);
          await this.state.writeIssueMemory(repo.name, uuid, { ...memory, pending: null });
          return "dropped";
        }
        await save({ landed: [...pending.landed, "move"] });
      }
      // A reply posted after the comment, before the move landed, counts too. One a snapshot saw while the comment
      // waited keeps the body it saw then. One no snapshot returned comes from this read.
      if (pending.pause !== null) {
        const commentAt = pending.comment_at ?? pending.tried_at;
        const seen = pending.replies.filter((reply) => reply.created_at > commentAt);
        const known = new Set(seen.map((reply) => reply.id));
        const unseen = repliesAfter(await this.tracker.issue(ref), commentAt).filter((reply) => !known.has(reply.id));
        replies = [...seen, ...unseen].sort((a, b) => a.created_at.localeCompare(b.created_at));
      }
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      await this.state.log(this.clock(), `${pending.issue}: runner comment pending: ${error.message}`);
      return "pending";
    }
    const memory = await this.state.issueMemory(repo.name, uuid);
    const pause = pending.pause === null ? memory.pause : { answers: pending.pause.answers, session: "", pending: false, comment_at: pending.comment_at ?? pending.tried_at, replies };
    await this.state.writeIssueMemory(repo.name, uuid, { ...memory, pause, pending: null });
    return "landed";
  }
}

/**
 * The comment an earlier try posted, if its response was lost: a top-level Linear comment, not through the
 * GitHub sync, created once the runner recorded the comment, with its status line and footer. Nothing else
 * happens to the issue while the comment waits, so no other runner comment matches.
 */
export function postedComment(issue: Pick<TrackerIssue, "comments">, pending: Pick<PendingComment, "body" | "status_line" | "since">): TrackerComment | undefined {
  const footer = pending.body
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line.startsWith("Flight Deck ") && line.endsWith(" · runner"));
  return issue.comments.find(({ body, synced, parent, created_at }) => {
    if (synced || parent !== null || created_at < pending.since) return false;
    const lines = body.split("\n").map((line) => line.trim());
    return lines[0] === pending.status_line && (footer === undefined || lines.includes(footer));
  });
}
