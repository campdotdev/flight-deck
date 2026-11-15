// `rate_limited` (spec 1, "Exits"). FLD-105 replaces this handler with the plan-limit hold, and puts the issue back in
// ready_to_plan keeping its attempt.
// Until then the runner logs the exit and ends the session, with no retry and no comment.
import type { ExitHandler } from "./context.ts";

export const rateLimited: ExitHandler = async (context) => {
  await context.log(`exit ${context.exit.kind}`);
  await context.finish();
};
