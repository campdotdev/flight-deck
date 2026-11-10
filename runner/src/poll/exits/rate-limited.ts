// `rate_limited`: the session hit a plan limit (spec 1, "Exits", ADRs 0002 and 0011). No failure and no comment.
// The runner holds itself until `resetsAt`, or for 1 minute when the exit carries none, and puts the issue back
// in its queue, where the next take keeps the attempt.
import { Usage } from "../usage.ts";
import type { ExitHandler } from "./context.ts";
import { requeue } from "./requeue.ts";

export const rateLimited: ExitHandler = async (context) => {
  if (context.exit.kind !== "rate_limited") return;
  await new Usage(context.state).rateLimited(context.now, context.config, context.exit.resetsAt);
  await requeue(context, "rate_limited");
};
