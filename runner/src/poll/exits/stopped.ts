// `stopped`: the runner asked the Harness to stop the session (spec 1, "Exits"). Its entry says why. After
// `flight-deck stop`, the runner pauses the issue with the ⚪ stop text, without a flag and without using the
// retry, and its `retry` moves the issue back to `ready_to_plan` (ADRs 0007, 0011, 0019, and 0021). After a
// move out of the working status, nothing more happens: the outbox goes with the session folder, because the
// maintainer moved the issue (ADR 0007). After SIGTERM, which marks the entry `shutdown`, the issue goes back in
// its queue with no comment, and the next take keeps the attempt (ADR 0002).
import { stopPause } from "../../outbox/runner-comments/stop.ts";
import type { ExitHandler } from "./context.ts";
import { requeue } from "./requeue.ts";

export const stopped: ExitHandler = async (context) => {
  switch (context.entry.stop_cause) {
    case "stop":
      return context.pause(stopPause());
    case "moved_out":
      await context.log("stopped after its issue moved out, outbox discarded");
      return context.finish();
    case undefined:
      if (context.entry.state === "shutdown") return requeue(context, "shutdown");
      await context.log("stopped, with no stop recorded");
      return context.finish();
  }
};
