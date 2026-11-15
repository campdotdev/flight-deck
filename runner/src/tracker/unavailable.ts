// A Tracker call Linear didn't take: a network error, a 5xx, or `RATELIMITED` (spec 1, "Outbox" and "The
// runner's own comments"). A later try may land, so callers keep what they meant to write and try again. Any
// other error is a bug or a refusal, and the caller doesn't retry it.

/** Why Linear didn't take the call. */
export type UnavailableReason = "network" | "server" | "rate_limited";

export class TrackerUnavailable extends Error {
  constructor(
    readonly reason: UnavailableReason,
    message = `Linear didn't take the call: ${reason}`,
  ) {
    super(message);
    this.name = "TrackerUnavailable";
  }
}

/** Whether the error is one a later try may get past. */
export function isUnavailable(error: unknown): error is TrackerUnavailable {
  return error instanceof TrackerUnavailable;
}
