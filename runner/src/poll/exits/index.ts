// What the runner does after each kind of exit (spec 1, "Exits"). Each kind's handler sits in its own file,
// so a change to one exit edits only that file.
import type { ExitKind } from "../../harness/index.ts";
import type { ExitHandler } from "./context.ts";
import { exited } from "./exited.ts";
import { loginExpired } from "./login-expired.ts";
import { noInit } from "./no-init.ts";
import { rateLimited } from "./rate-limited.ts";
import { stopped } from "./stopped.ts";
import { timedOut } from "./timed-out.ts";

export type { ExitContext, ExitHandler } from "./context.ts";

export const EXITS: Record<ExitKind["kind"], ExitHandler> = {
  exited,
  no_init: noInit,
  timed_out: timedOut,
  stopped,
  rate_limited: rateLimited,
  login_expired: loginExpired,
};
