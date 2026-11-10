// The production adapters (overview, "Module map"): the Linear adapter as the Flight Deck app for the runner and
// as the maintainer for `flight-deck apply`, and the Claude Code adapter. Tests pass the in-memory and scripted
// adapters through the same `Adapters` and `RunnerAdapters` instead.
import type { Folders } from "../folders/index.ts";
import { ClaudeCodeHarness } from "../harness/claude-code.ts";
import { linearApps, readCredentials } from "../install/index.ts";
import { State } from "../state/index.ts";
import { LinearTracker, type LinearTrackerOptions } from "../tracker/index.ts";
import type { Adapters, RunnerAdapters } from "./context.ts";

/** The workspace's apps from `credentials.env`, read at each mint, so a rotated secret takes effect at the next mint. */
function apps(folders: Folders): LinearTrackerOptions["apps"] {
  return async (workspace) => linearApps(await readCredentials(folders), workspace);
}

export const PRODUCTION_ADAPTERS: Adapters = {
  // The setup key goes to Linear as it is, and mints and revokes nothing, so the adapter has nothing to log.
  maintainerTracker: ({ folders, setupKey }) => new LinearTracker({ identity: { kind: "setup_key", key: setupKey }, apps: apps(folders) }),
};

export const PRODUCTION_RUNNER: RunnerAdapters = {
  // A failed revoke goes to the runner's log.
  runnerTracker: ({ folders }) => {
    const state = new State(folders);
    return new LinearTracker({ identity: { kind: "flight_deck" }, apps: apps(folders), log: (message) => void state.log(new Date(), message) });
  },
  // The adapter takes `[paths]` `claude` at its start, so a changed path takes effect when the runner restarts.
  harness: ({ config }) => new ClaudeCodeHarness({ claude: config.paths.claude }),
};
