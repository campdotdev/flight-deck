import type { Role } from "../record/index.ts";
import type { IssueRef, Tracker } from "../tracker/index.ts";

/** Why the runner moves an issue. Each row of the move table names one. */
export const CAUSES = [
  /** The runner takes the issue. */
  "take",
  /** The runner pauses the issue instead of taking it: a canceled blocker, a duplicate of nothing, a port in use. */
  "pause_before_take",
  /** The stage's outbox hands off. */
  "handoff",
  /** The stage's outbox pauses, or the runner pauses the issue during or after a session. */
  "pause",
  /** Plan's outbox marks a duplicate. */
  "duplicate",
  /** The runner puts the issue back in its queue: a plan limit, an expired login, a failed Reader mint, a shutdown. */
  "requeue",
  /** The maintainer's reply starts with one of the pause's answers. */
  "answer",
] as const;

export type Cause = (typeof CAUSES)[number];

/** Spec 1's moves, as roles. No other move by the runner is allowed. */
const MOVES: readonly { from: Role; to: Role; cause: Cause }[] = [
  { from: "ready_to_plan", to: "planning", cause: "take" },
  { from: "ready_to_plan", to: "paused", cause: "pause_before_take" },
  { from: "planning", to: "ready_to_build", cause: "handoff" },
  { from: "planning", to: "paused", cause: "pause" },
  { from: "planning", to: "duplicate", cause: "duplicate" },
  { from: "planning", to: "ready_to_plan", cause: "requeue" },
  // An answer moves the issue to its queue role. Plan's answers name only `ready_to_plan`, which the Outbox checks.
  { from: "paused", to: "ready_to_plan", cause: "answer" },
  { from: "paused", to: "ready_to_build", cause: "answer" },
  { from: "paused", to: "ready_to_check", cause: "answer" },
];

export type MoveResult = { ok: true } | { ok: false; violation: string };

export interface MoveOptions {
  /** For a duplicate: the open issue it duplicates. */
  of?: IssueRef;
}

/** The only caller of `Tracker.move`. */
export class Lifecycle {
  constructor(private readonly tracker: Tracker) {}

  /** Whether the table allows the move for this cause. */
  allows(from: Role, to: Role, cause: Cause): boolean {
    return MOVES.some((row) => row.from === from && row.to === to && row.cause === cause);
  }

  /** Makes the move when the table allows it, and returns a violation otherwise. */
  async move(issue: IssueRef & { role: Role }, to: Role, cause: Cause, options: MoveOptions = {}): Promise<MoveResult> {
    const from = issue.role;
    if (!this.allows(from, to, cause)) {
      return { ok: false, violation: `${from} to ${to} is not a move for ${cause}` };
    }
    if (to === "duplicate") {
      if (options.of === undefined) return { ok: false, violation: `${from} to ${to} needs the issue it duplicates` };
      await this.tracker.markDuplicate(issue, options.of);
    } else {
      await this.tracker.move(issue, to);
    }
    return { ok: true };
  }
}
