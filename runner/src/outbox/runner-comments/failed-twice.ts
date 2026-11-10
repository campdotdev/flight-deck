// A second failed session pauses the issue (spec 1's "Exits" under "Failed", ADRs 0002 and 0019).
import type { RunnerText } from "./frame.ts";

/** How a session failed. */
export type FailedExit =
  /** The session ran past the stage's time limit, in milliseconds. */
  | { kind: "timed_out"; limitMs: number }
  /** `Outbox.apply` returned `failed` with this rule. */
  | { kind: "refused"; rule: string }
  /** `Workspace.prepare` failed with this message, so no session started. */
  | { kind: "prepare"; message: string }
  /** Any other exit without a handoff. */
  | { kind: "error" };

/** The second failure's text. Its `retry` restores the stage's retry, so the next take has attempt 1. */
export function failedTwice(failure: FailedExit): RunnerText {
  const where = failure.kind === "prepare" ? "Flight Deck's message is under Details." : "Its transcript path is under Details.";
  return {
    statusLine: "🟡 Needs your help: plan failed twice",
    sentences: `Plan ran twice, and neither session handed off. The second one ${secondExit(failure)}. ${where}`,
    flag: "pause",
    answers: [{ word: "retry", does: "plan runs again, with a fresh retry if it fails", move: "ready_to_plan" }],
  };
}

function secondExit(failure: FailedExit): string {
  switch (failure.kind) {
    case "timed_out":
      return `ran past plan's ${limit(failure.limitMs)} limit`;
    case "refused":
      return `wrote a handoff Flight Deck refused, because ${failure.rule.replace(/[.\s]+$/, "")}`;
    case "prepare":
      return "couldn't start, because Flight Deck couldn't prepare its worktree";
    case "error":
      return "stopped with an error";
  }
}

/** A time limit as "30-minute" under 2 hours, and in whole hours, rounded down, from there, such as "3-hour". */
function limit(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 120 ? `${minutes}-minute` : `${Math.floor(minutes / 60)}-hour`;
}
