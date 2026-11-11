// Puts a session's issue back in its queue without using the stage's retry, after a plan limit, an expired
// login, a failed Reader mint, or a shutdown (spec 1, "Exits", ADR 0002). The next take keeps the attempt the
// session had, so issue memory records it before the move.
import { Lifecycle } from "../../lifecycle/index.ts";
import type { RestartCause } from "../../state/index.ts";
import { stillWorking } from "../moved-out.ts";
import { WORKING } from "../stages.ts";
import type { ExitContext } from "./context.ts";

/**
 * Moves the session's issue from the working status back to its queue, with no comment, then ends the session.
 * The entry stays until the move lands, so a Linear read or move that fails runs again at the next poll.
 */
export async function requeue(context: ExitContext, after: RestartCause): Promise<void> {
  const { entry, repo, state, tracker } = context;
  // An issue the maintainer archived, deleted, or moved to another team has left the stage too.
  const issue = await stillWorking(tracker, repo, entry);
  if (issue === null || issue.role === null) {
    await context.finish();
    await context.log(`left ${WORKING[entry.stage]}, not requeued`);
    return;
  }
  const memory = await state.issueMemory(repo.name, entry.issue_id);
  await state.writeIssueMemory(repo.name, entry.issue_id, { ...memory, restart: { attempt: entry.attempt, after } });
  const moved = await new Lifecycle(tracker).move({ ...issue, role: issue.role }, "ready_to_plan", "requeue");
  await context.finish();
  await context.log(moved.ok ? `requeued after ${after}, attempt ${entry.attempt} kept` : `requeue refused: ${moved.violation}`);
}
