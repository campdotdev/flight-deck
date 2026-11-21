// An apply that couldn't write to Linear for 3 hours pauses the issue and keeps plan's handoff (spec 1's
// "Exits" under "Not yet written"). Its `retry` moves the issue to Ready to plan, where the next take applies
// the kept outbox instead of starting a session.
import type { RunnerText } from "./frame.ts";

/** `kept` is the kept folder's path, which the fold names. */
export function linearWrite(kept: string): RunnerText {
  return {
    statusLine: "🟡 Needs your help: Flight Deck couldn't write to Linear",
    sentences:
      "Plan finished, but for 3 hours Linear refused Flight Deck's writes or didn't answer them. Flight Deck kept plan's handoff on the Mac. A retry writes that handoff with no new session.",
    flag: "pause",
    answers: [{ word: "retry", does: "Flight Deck writes the kept handoff", move: "ready_to_plan" }],
    details: `The handoff is kept in \`${kept}\`.`,
  };
}
