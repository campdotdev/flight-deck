// A second failed session pauses the issue (spec 1's "Exits" under "Failed", ADRs 0002 and 0019).
import type { RunnerText } from "./frame.ts";

/** How a session failed. */
export type FailedExit =
  /** The session ran past the stage's time limit, in milliseconds. */
  | { kind: "timed_out"; limitMs: number }
  /**
   * `Outbox.apply` returned `failed` with this rule, or `null` when the secret scan matched the rule's text, which
   * can quote what the session wrote.
   */
  | { kind: "refused"; rule: string | null }
  /** `Workspace.prepare` failed with this message, so no session started. */
  | { kind: "prepare"; message: string }
  /** Any other exit without a handoff. */
  | { kind: "error" }
  /** The runner stopped while the session ran, and found it ended or killed it at its next start. */
  | { kind: "cut_off"; transcript: boolean };

/** The second failure's text. Its `retry` restores the stage's retry, so the next take has attempt 1. */
export function failedTwice(failure: FailedExit): RunnerText {
  return {
    statusLine: "🟡 Needs your help: plan failed twice",
    sentences: `Plan ran twice, and neither session handed off. The second one ${secondExit(failure)}.${where(failure)}`,
    flag: "pause",
    answers: [{ word: "retry", does: "plan runs again, with a fresh retry if it fails", move: "ready_to_plan" }],
  };
}

/** Where the Details fold points the maintainer, if anywhere. */
function where(failure: FailedExit): string {
  if (failure.kind === "prepare") return " Flight Deck's message is under Details.";
  // A session cut off before it started has no transcript.
  if (failure.kind === "cut_off" && !failure.transcript) return "";
  return " Its transcript path is under Details.";
}

function secondExit(failure: FailedExit): string {
  switch (failure.kind) {
    case "timed_out":
      return `ran past plan's ${limit(failure.limitMs)} limit`;
    case "refused":
      if (failure.rule === null) return "wrote a handoff Flight Deck refused, and the rule it broke is left out: it matched a secret rule";
      return `wrote a handoff Flight Deck refused, because ${failure.rule.replace(/[.\s]+$/, "")}`;
    case "prepare":
      return "couldn't start, because Flight Deck couldn't prepare its worktree";
    case "error":
      return "stopped with an error";
    case "cut_off":
      return "was still running when Flight Deck's runner stopped";
  }
}

/** A time limit as "30-minute" under 2 hours, and in whole hours, rounded down, from there, such as "3-hour". */
function limit(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 120 ? `${minutes}-minute` : `${Math.floor(minutes / 60)}-hour`;
}
