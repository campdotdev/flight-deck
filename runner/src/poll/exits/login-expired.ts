// `login_expired` (spec 1, "Exits", ADRs 0005 and 0011). The Poll opens the trouble cause `claude_login`, which
// holds new work until a trial run passes. The issue goes back to its queue with no comment, and the next take
// keeps the attempt, because an expired login isn't the session's failure.
import type { ExitHandler } from "./context.ts";
import { requeue } from "./requeue.ts";

export const loginExpired: ExitHandler = (context) => requeue(context, "login_expired");
