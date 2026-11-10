// `stopped` (spec 1, "Exits"). FLD-104 replaces this handler with the stop pause, and with nothing more for a session
// stopped because its issue moved out.
// Until then the runner logs the exit and ends the session, with no retry and no comment.
import type { ExitHandler } from "./context.ts";

export const stopped: ExitHandler = async (context) => {
  await context.log(`exit ${context.exit.kind}`);
  await context.finish();
};
