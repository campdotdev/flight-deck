// Poll step 8, stale takes (spec 1, "Poll", ADR 0011). The runner flags, once per stay in the status, each issue
// in a working status with no session in the session list, once it has sat there past its stage's time limit,
// measured from `status_since`. A flag the maintainer clears by hand while the issue stays doesn't come back.
import { runnerComment } from "../outbox/runner-comments/frame.ts";
import { staleTake } from "../outbox/runner-comments/stale-take.ts";
import type { RunnerComments } from "../outbox/runner-comments/writes.ts";
import { durationMs, type RepoRecord, type Role } from "../record/index.ts";
import type { SessionEntry, State, Status } from "../state/index.ts";
import type { Snapshot, TrackerRepo } from "../tracker/index.ts";

/** Each working status's stage, and the queue the issue goes back to. */
const STAGES: Partial<Record<Role, { stage: "plan" | "build" | "check"; queue: Role }>> = {
  planning: { stage: "plan", queue: "ready_to_plan" },
  building: { stage: "build", queue: "ready_to_build" },
  checking: { stage: "check", queue: "ready_to_check" },
};

export interface StaleTakeInput {
  now: Date;
  repo: TrackerRepo;
  snapshot: Snapshot;
  /** The issues with a runner comment still to land. Nothing else happens to them this poll. */
  blocked: Set<string>;
  /** The default branch's record, or the last valid one the runner read. `null` when the repo never had one. */
  record: RepoRecord | null;
  sessions: SessionEntry[];
  state: State;
  comments: RunnerComments;
  version: string;
}

/** Flags each stale take not yet flagged in its stay, and returns every stale take for `status.json`. */
export async function staleTakes(input: StaleTakeInput): Promise<Status["stale_takes"]> {
  const { now, repo, record } = input;
  if (record === null) return [];
  const listed = new Set(input.sessions.map((entry) => entry.issue_id));
  const stale: Status["stale_takes"] = [];
  for (const issue of input.snapshot.issues) {
    const stage = STAGES[issue.role];
    if (stage === undefined || listed.has(issue.id) || input.blocked.has(issue.id)) continue;
    const sinceMs = now.getTime() - Date.parse(issue.status_since);
    if (sinceMs <= durationMs(record.time_limits[stage.stage])) continue;
    stale.push({ repo: repo.name, issue: issue.identifier, title: issue.title, status: issue.status, since: issue.status_since });

    if ((await input.state.issueMemory(repo.name, issue.id)).stale_take === issue.status_since) continue;
    const text = staleTake({ status: issue.status, queue: repo.statuses[stage.queue], sinceMs });
    const result = await input.comments.post(issue, runnerComment(text, {}, { version: input.version, statuses: repo.statuses }));
    const memory = await input.state.issueMemory(repo.name, issue.id);
    await input.state.writeIssueMemory(repo.name, issue.id, { ...memory, stale_take: issue.status_since });
    await input.state.log(now, `${issue.identifier}: stale take ${result}`);
  }
  return stale;
}
