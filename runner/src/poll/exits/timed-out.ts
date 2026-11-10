// `timed_out`: the session ran past the stage's deadline. It counts as a failed session (spec 1, "Exits").
import type { ExitHandler } from "./context.ts";

export const timedOut: ExitHandler = (context) => {
  const { started_at, deadline } = context.entry;
  const limitMs = started_at === null || deadline === null ? 0 : new Date(deadline).getTime() - new Date(started_at).getTime();
  return context.fail({ kind: "timed_out", limitMs });
};
