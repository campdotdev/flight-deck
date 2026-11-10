// Step 4 of the poll, moved out (spec 1's "Poll", ADR 0007). For each session whose issue no longer sits in its
// working status, or was deleted, archived, or moved to another team, the runner stops the session and
// discards its outbox. Pushed commits and other writes stay. The maintainer moved the issue, so the runner
// posts nothing and uses no retry.
import type { SessionEntry, State } from "../state/index.ts";
import { IssueNotFoundError, type Snapshot, type Tracker, type TrackerIssue, type TrackerRepo } from "../tracker/index.ts";
import { WORKING } from "./stages.ts";

export interface MovedOutContext {
  now: Date;
  repo: TrackerRepo;
  snapshot: Snapshot;
  state: State;
  /** Asks the Harness to stop a running session because its issue moved out. Its `stopped` exit disposes it. */
  stop(entry: SessionEntry): Promise<void>;
  /** Discards an `apply_waiting` entry's outbox, its folder, and a kept outbox it applies, and drops the entry. */
  discard(entry: SessionEntry): Promise<void>;
}

export async function movedOut(context: MovedOutContext): Promise<void> {
  const { now, repo, snapshot, state } = context;
  for (const entry of await state.sessions()) {
    if (entry.repo !== repo.name) continue;
    const issue = snapshot.issues.find((each) => each.id === entry.issue_id);
    if (issue !== undefined && issue.role === WORKING[entry.stage]) continue;
    const log = (message: string) => state.log(now, `${entry.id} ${entry.issue}: left ${WORKING[entry.stage]}, ${message}`);
    switch (entry.state) {
      case "running":
        await context.stop(entry);
        break;
      case "retry_waiting":
        // The failed session's workspace already went, so only the entry is left.
        await log("retry dropped");
        await drop(state, entry);
        break;
      case "apply_waiting":
        // Before the status move landed, the outbox is discarded (ADR 0007). Once it landed, the stage handed off,
        // and the writes after it keep retrying. A `pause` entry's issue may sit in Paused while the Linear-write
        // pause's comment waits, and its kept outbox must outlive that, so `ApplyWaiting` settles it (FLD-100).
        if (entry.apply !== undefined && entry.apply.phase !== "apply") break;
        await context.discard(entry);
        break;
      case "starting":
      case "shutdown":
        // A restart handles these. A live runner never leaves an entry `starting` between ticks.
        break;
    }
  }
}

/**
 * Re-reads the issue, and returns it while it still sits in the stage's working status on the repo's team.
 * Returns `null` once it was deleted, archived, moved to another team, or moved out of the working status.
 */
export async function stillWorking(tracker: Tracker, repo: TrackerRepo, entry: SessionEntry): Promise<TrackerIssue | null> {
  let issue: TrackerIssue;
  try {
    issue = await tracker.issue({ id: entry.issue_id, repo });
  } catch (error) {
    if (error instanceof IssueNotFoundError) return null;
    throw error;
  }
  const working = WORKING[entry.stage];
  return working !== undefined && issue.role === working && issue.team === repo.team && !issue.archived ? issue : null;
}

async function drop(state: State, entry: SessionEntry): Promise<void> {
  await state.dropSession(entry.id);
}
