// The writes a runner comment makes (spec 1, "The runner's own comments"). A pause makes the same writes as an
// outbox's `paused`, in the same order, and files no follow-up issue: the flag in issue memory, `Tracker.post`
// (flagged, except for the stop pause), `Lifecycle.move(issue, paused)`, then the answers and the comment's
// time in issue memory. When Linear doesn't take a write, the comment waits in issue memory, and the next poll
// tries the writes still to land. Nothing else happens to the issue until it lands.
import { Lifecycle } from "../../lifecycle/index.ts";
import type { Role } from "../../record/index.ts";
import type { PendingComment, State } from "../../state/index.ts";
import { isUnavailable, type Tracker, type TrackerRepo } from "../../tracker/index.ts";
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

  /** Records the comment in issue memory, then makes its writes. */
  async post(target: RunnerTarget, comment: RunnerComment): Promise<RunnerWriteResult> {
    const pending: PendingComment = {
      body: comment.body,
      status_line: comment.statusLine,
      flag: comment.flag,
      pause: comment.answers === null ? null : { from: target.role, answers: [...comment.answers] },
      landed: [],
      comment_at: null,
      tried_at: this.clock().toISOString(),
      issue: target.identifier,
      title: target.title,
      url: target.url,
    };
    const memory = await this.state.issueMemory(target.repo.name, target.id);
    await this.state.writeIssueMemory(target.repo.name, target.id, { ...memory, pending });
    return this.write(target.repo, target.id, pending);
  }

  /**
   * Tries the issue's pending comment again, unless the last try was at this poll or its `not_before` hasn't
   * come. `issue` is the issue as this poll read it, or `null` when the snapshot no longer holds it. When the
   * issue moved before the pause's move landed, the comment is dropped, because the maintainer moved it.
   */
  async retry(repo: TrackerRepo, uuid: string, issue: { role: Role | null } | null): Promise<RunnerWriteResult | null> {
    const memory = await this.state.issueMemory(repo.name, uuid);
    const pending = memory.pending;
    const now = this.clock().toISOString();
    if (pending === null) return null;
    if (pending.tried_at >= now || (pending.not_before !== undefined && now < pending.not_before)) return "pending";
    const moved = pending.pause !== null && !pending.landed.includes("move") && issue?.role !== pending.pause.from;
    if (issue === null || moved) {
      const flag = pending.landed.includes("post") ? memory.flag : null;
      await this.state.writeIssueMemory(repo.name, uuid, { ...memory, flag, pending: null });
      await this.state.log(this.clock(), `${pending.issue}: moved on, runner comment dropped: ${pending.status_line}`);
      return "dropped";
    }
    const tried = { ...pending, tried_at: this.clock().toISOString() };
    await this.state.writeIssueMemory(repo.name, uuid, { ...memory, pending: tried });
    return this.write(repo, uuid, tried);
  }

  /** Makes each write still to land, recording each in issue memory as it lands. */
  private async write(repo: TrackerRepo, uuid: string, start: PendingComment): Promise<RunnerWriteResult> {
    let pending = start;
    const save = async (patch: Partial<PendingComment>) => {
      pending = { ...pending, ...patch };
      const memory = await this.state.issueMemory(repo.name, uuid);
      await this.state.writeIssueMemory(repo.name, uuid, { ...memory, pending });
    };
    const ref = { id: uuid, repo };
    try {
      if (!pending.landed.includes("post")) {
        if (pending.flag !== null) {
          // The flag goes into issue memory first, so the next poll never takes the assignee for one the runner didn't set.
          const memory = await this.state.issueMemory(repo.name, uuid);
          const flag = { cause: pending.flag, status_line: pending.status_line, since: this.clock().toISOString(), issue: pending.issue, title: pending.title, url: pending.url };
          await this.state.writeIssueMemory(repo.name, uuid, { ...memory, flag });
        }
        const posted = await this.tracker.post(ref, pending.body, { flag: pending.flag !== null });
        await save({ landed: [...pending.landed, "post"], comment_at: posted.created_at });
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
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      await this.state.log(this.clock(), `${pending.issue}: runner comment pending: ${error.message}`);
      return "pending";
    }
    const memory = await this.state.issueMemory(repo.name, uuid);
    const pause = pending.pause === null ? memory.pause : { answers: pending.pause.answers, comment_at: pending.comment_at ?? pending.tried_at, replies: [] };
    await this.state.writeIssueMemory(repo.name, uuid, { ...memory, pause, pending: null });
    return "landed";
  }
}
