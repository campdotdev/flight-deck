// `flight-deck hold`, `start`, and `stop` (spec 1, "The runner's socket" and "Holds", ADR 0021). Each asks the
// runner over its socket, because the runner, not the command line, sends every signal to a session. When the
// runner doesn't answer, `hold` and `stop` write the hold marker and `start` removes it, and the runner reads
// the marker at its next start. `stop` asks for no confirmation, because the menu bar app asks first.
import { paths } from "../folders/index.ts";
import { State } from "../state/index.ts";
import { ask } from "../socket/index.ts";
import { ANSWER_MS, type CommandContext } from "./context.ts";

type HoldOp = "hold" | "start" | "stop";

const ANSWERED: Record<HoldOp, string> = {
  hold: "Flight Deck is held: running sessions finish, and no new session starts. Run flight-deck start to end the hold.",
  start: "Flight Deck is working: the hold has ended.",
  stop: "Flight Deck stopped every session and holds new work. Each issue it stopped is paused with a retry answer. Run flight-deck start to end the hold.",
};

const UNANSWERED: Record<HoldOp, string> = {
  hold: "The runner didn't answer, so Flight Deck wrote the hold marker. The runner reads it at its next start.",
  start: "The runner didn't answer, so Flight Deck removed the hold marker. The runner starts work at its next poll.",
  stop: "The runner didn't answer, so Flight Deck wrote the stop marker. The runner stops every session at its next start.",
};

export async function holdCommand(op: HoldOp, context: CommandContext): Promise<number> {
  const reply = await ask(paths.socket(context.folders), { op }, context.answerMs ?? ANSWER_MS);
  if (reply !== null && !reply.ok) {
    context.err(`The runner refused ${op}: ${reply.error}`);
    return 1;
  }
  if (reply !== null) {
    context.out(ANSWERED[op]);
    return 0;
  }
  // The marker the runner writes when it answers: a hold keeps any marker, a stop replaces one.
  const state = new State(context.folders);
  const since = context.clock().toISOString();
  if (op === "hold" && (await state.holdMarker()) === null) await state.writeHoldMarker({ by: "hold", since });
  if (op === "stop") await state.writeHoldMarker({ by: "stop", since });
  if (op === "start") await state.writeHoldMarker(null);
  context.out(UNANSWERED[op]);
  return 0;
}
