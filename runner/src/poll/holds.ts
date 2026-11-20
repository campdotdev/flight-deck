// The holds (spec 1's "Holds", ADR 0021). A hold stops new sessions while running ones finish. A held runner
// still polls, applies outboxes, and flags. The runner is held while any hold with the `runner` scope holds,
// and a hold scoped to a workspace or a repo stops only that one's starts.
//
// Each cause comes from one source in `HOLD_SOURCES`. A ticket that adds a cause writes its source in its own
// file and adds one line to the list.
import type { Config } from "../install/index.ts";
import type { State, Status, StatusHold } from "../state/index.ts";
import type { Trouble } from "./trouble/trouble.ts";

/** What a hold source reads. */
export interface HoldContext {
  now: Date;
  state: State;
  config: Config;
  /** This poll's trouble causes, which steps 1 and 2 and the version check opened or cleared. */
  trouble: Trouble;
}

/** Returns the holds one cause, or one family of causes, puts on the runner now. */
export type HoldSource = (context: HoldContext) => Promise<StatusHold[]>;

/** `maintainer` and `stop`, from the hold marker: `flight-deck hold` and `flight-deck stop` (ADRs 0021 and 0024). */
export const markerHolds: HoldSource = async ({ state }) => {
  const marker = await state.holdMarker();
  if (marker === null) return [];
  return [{ cause: marker.by === "stop" ? "stop" : "maintainer", scope: "runner", name: null, since: marker.since, until: null }];
};

/** Each open trouble cause that stops sessions, with its scope (spec 1's "Trouble issues"). */
export const troubleHolds: HoldSource = async ({ now, trouble }) => trouble.holds(now);

/** Every source, in the order `status.json` lists their holds. */
export const HOLD_SOURCES: HoldSource[] = [markerHolds, troubleHolds];

/** Every hold that holds now. */
export async function currentHolds(context: HoldContext): Promise<StatusHold[]> {
  const holds: StatusHold[] = [];
  for (const source of HOLD_SOURCES) holds.push(...(await source(context)));
  return holds;
}

/** `stopped` under a `stop` hold, `held` under any other hold with the `runner` scope, and `working` otherwise. */
export function runnerState(holds: readonly StatusHold[]): Status["runner"]["state"] {
  if (holds.some((hold) => hold.cause === "stop")) return "stopped";
  return holds.some((hold) => hold.scope === "runner") ? "held" : "working";
}

/** Whether a hold stops starts for the repo: one on the whole runner, the repo's workspace, or the repo itself. */
export function holdsRepo(holds: readonly StatusHold[], repo: { name: string; workspace: string }): boolean {
  return holds.some(
    (hold) => hold.scope === "runner" || (hold.scope === "workspace" && hold.name === repo.workspace) || (hold.scope === "repo" && hold.name === repo.name),
  );
}
