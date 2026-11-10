// The production adapters (overview, "Module map"): the Linear adapter as the Flight Deck app for the runner and
// as the maintainer for `flight-deck apply`, and the Claude Code adapter. Tests pass the in-memory and scripted
// adapters through the same `Adapters` and `RunnerAdapters` instead.
import { ClaudeCodeHarness } from "../harness/claude-code.ts";
import type { Tracker } from "../tracker/index.ts";
import type { Adapters, RunnerAdapters } from "./context.ts";

// FLD-111 builds the Linear adapter on its own branch. Its merge replaces this with the adapter: as the Flight
// Deck app, from `credentials.env`'s `LINEAR_APP_ID_<WS>` and `LINEAR_APP_SECRET_<WS>`, and as the maintainer,
// from the setup key.
function linearAdapter(identity: string): Tracker {
  throw new Error(`This build has no Linear adapter yet, so Flight Deck can't reach Linear as ${identity}.`);
}

export const PRODUCTION_ADAPTERS: Adapters = {
  maintainerTracker: ({ workspace }) => linearAdapter(`the maintainer in ${workspace}`),
};

export const PRODUCTION_RUNNER: RunnerAdapters = {
  runnerTracker: () => linearAdapter("the Flight Deck app"),
  // The adapter takes `[paths]` `claude` at its start, so a changed path takes effect when the runner restarts.
  harness: ({ config }) => new ClaudeCodeHarness({ claude: config.paths.claude }),
};
