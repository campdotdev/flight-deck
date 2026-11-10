// A stale take: an issue sits in a working status past its stage's time limit with no session in the session
// list, such as a hand run that never finished (spec 1, "The runner's own comments", poll step 8, ADR 0011).
// It flags the maintainer and pauses nothing.
import type { RunnerText } from "./frame.ts";

export interface StaleTakeInput {
  /** The team's name for the working status the issue sits in. */
  status: string;
  /** The team's name for that stage's queue. */
  queue: string;
  /** How long the issue has sat in the status, in milliseconds. */
  sinceMs: number;
}

export function staleTake(input: StaleTakeInput): RunnerText {
  return {
    statusLine: `🟡 Needs your help: in ${input.status} for ${duration(input.sinceMs)} with no Flight Deck session`,
    sentences: `No Flight Deck session is working on this issue. If you're running the stage by hand, finish that run. Otherwise, move the issue back to ${input.queue}, and the factory takes it.`,
    flag: "stale_take",
    answers: null,
  };
}

/** A duration in minutes under 2 hours, such as "45 minutes", and in whole hours, rounded down, from there, such as "3 hours". */
export function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 120) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  return `${Math.floor(minutes / 60)} hours`;
}
