// Step 4 of the poll, moved out (spec 1's "Poll", ADR 0007). For each session whose issue no longer sits in its
// working status, or was deleted, archived, or moved to another team, the runner stops the session and
// discards its outbox. Pushed commits and other writes stay. The maintainer moved the issue, so the runner
// posts nothing and uses no retry.
import { join } from "node:path";
import { paths, type Folders } from "../folders/index.ts";
import { readJson, type SessionEntry, type State } from "../state/index.ts";
import { IssueNotFoundError, type Snapshot, type Tracker, type TrackerIssue, type TrackerRepo } from "../tracker/index.ts";
import type { Workspace } from "../workspace/index.ts";
import { WORKING } from "./stages.ts";

export interface MovedOutContext {
  now: Date;
  repo: TrackerRepo;
  snapshot: Snapshot;
  state: State;
  workspace: Workspace;
  folders: Folders;
  /** Asks the Harness to stop a running session because its issue moved out. Its `stopped` exit disposes it. */
  stop(entry: SessionEntry): Promise<void>;
}

export async function movedOut(context: MovedOutContext): Promise<void> {
  const { now, repo, snapshot, state, workspace } = context;
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
        // Once the move landed, the stage handed off, and the writes after it keep retrying (FLD-100).
        if (await moveLanded(paths.sessionFolder(context.folders, entry.id))) break;
        await log("outbox discarded");
        await workspace.dispose({ session: entry.id, worktree: entry.worktree });
        await drop(state, entry);
        break;
      case "starting":
      case "shutdown":
        // A restart handles these (FLD-108). A live runner never leaves an entry `starting` between ticks.
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

/** Whether the outbox's status move landed, from the writes `applied.json` records. */
async function moveLanded(sessionFolder: string): Promise<boolean> {
  return (await readJson<{ writes: string[] }>(join(sessionFolder, "applied.json"), { writes: [] })).writes.includes("move");
}

async function drop(state: State, entry: SessionEntry): Promise<void> {
  await state.writeSessions((await state.sessions()).filter((each) => each.id !== entry.id));
}
