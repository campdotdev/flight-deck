// `Outbox.apply` returned `unwritten`: Linear didn't take a write (spec 1's "Exits", "Not yet written"). The
// outbox stays in the session folder, the worktree goes, and the entry waits as `apply_waiting`, which takes
// no place under the cap. `../apply-waiting.ts` tries it again with no session and uses no retry.
import type { ApplyResult } from "../../outbox/index.ts";
import { phaseAfter, waitingEntry } from "../apply-waiting.ts";
import type { ExitContext } from "./context.ts";

export async function waitToApply(context: ExitContext, result: Extract<ApplyResult, { result: "unwritten" }>): Promise<void> {
  const { entry, now, state } = context;
  await context.workspace.dispose({ session: entry.id, worktree: entry.worktree }, { keepFolder: true });
  const waiting = waitingEntry(entry, { folder: context.sessionFolder, phase: phaseAfter("apply", result), now });
  await state.writeSessions((await state.sessions()).map((each) => (each.id === entry.id ? waiting : each)));
  await context.log(`Linear didn't take every write, the outbox waits to apply again (${waiting.apply?.phase})`);
}
