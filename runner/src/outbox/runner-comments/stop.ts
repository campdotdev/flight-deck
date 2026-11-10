// `flight-deck stop` pauses each session's issue, and each issue whose retry waits, without a flag and without
// using the retry (spec 1's "Holds" and "Exits", ADRs 0007, 0011, 0019, and 0021). The maintainer stopped the
// runner, so the comment only says so, and its `retry` moves the issue back to its queue.
import type { RunnerText } from "./frame.ts";

export function stopPause(): RunnerText {
  return {
    statusLine: "⚪ Stopped: you stopped Flight Deck while plan ran",
    sentences: null,
    flag: null,
    answers: [{ word: "retry", does: "plan runs again", move: "ready_to_plan" }],
  };
}
