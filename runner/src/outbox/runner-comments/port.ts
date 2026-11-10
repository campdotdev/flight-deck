// A single-instance app's port in use pauses the issue from Ready to plan instead of taking it, so a session
// never proves against another process on that port (spec 1's "Starts" and "The runner's own comments", ADRs
// 0003 and 0022). It uses no retry.
import type { RunnerText } from "./frame.ts";

export function portPause(port: number): RunnerText {
  return {
    statusLine: `🟡 Needs your help: port ${port} is in use`,
    sentences: `This repo's app runs only on port ${port}, so plan can't start while something else on the Mac uses it. Stop whatever uses port ${port}, such as your own dev server, then reply.`,
    flag: "pause",
    answers: [{ word: "retry", does: "Flight Deck tests the port again", move: "ready_to_plan" }],
  };
}
