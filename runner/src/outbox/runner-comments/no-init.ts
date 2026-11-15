// A session that never sent its `init` event pauses the issue without using the retry (spec 1's "Exits",
// ADRs 0007 and 0019). The Harness stops it 2 minutes after the start.
import type { RunnerText } from "./frame.ts";

export function noInit(): RunnerText {
  return {
    statusLine: "🟡 Needs your help: plan's session never started",
    sentences:
      "Claude Code didn't start plan's session within 2 minutes, so Flight Deck stopped it. The usual cause is a prompt on the Mac. Dismiss any dialog from macOS or Claude Code on the Mac before you reply.",
    flag: "pause",
    answers: [{ word: "retry", does: "plan runs again", move: "ready_to_plan" }],
  };
}
