// `rate_limited`: the session hit a plan limit (spec 1, "Exits", ADRs 0002 and 0011). No failure and no comment.
// `Poll.handleExit` has already held the runner until `resetsAt`, or for 1 minute when the exit carries none, so
// the hold lands even when the issue's repo is gone. This handler puts the issue back in its queue, where the
// next take keeps the attempt.
import type { ExitHandler } from "./context.ts";
import { requeue } from "./requeue.ts";

export const rateLimited: ExitHandler = async (context) => {
  if (context.exit.kind !== "rate_limited") return;
  await requeue(context, "rate_limited");
};
