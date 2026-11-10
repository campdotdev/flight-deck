// Single-instance apps (spec 1's "Starts", ADRs 0003 and 0022). A repo whose `[app]` says `single_instance = true`
// runs at most one session at a time, always on `default_port`. Before a take for that repo, the runner tests the
// port. When something else uses it, it takes nothing for the repo, pauses the first issue in the order from
// Ready to plan, and the repo's other queued issues wait under `waiting_for_port` until that pause's `retry` or a
// free port. The test belongs to a take, so a held runner doesn't run it.
import type { RecordResult, RepoRecord } from "../record/index.ts";
import type { PortPause, SessionEntry, State } from "../state/index.ts";
import type { Snapshot } from "../tracker/index.ts";

type App = NonNullable<RepoRecord["app"]>;

/** The repo's app when the default branch's record marks it single-instance, else `null`. */
export function singleInstanceApp(record: RecordResult | null): App | null {
  if (record?.ok !== true) return null;
  const app = record.record.app;
  return app?.single_instance === true ? app : null;
}

/** Whether the repo has a session that holds its one place: any listed entry but an outbox waiting for Linear. */
export function runsOne(sessions: readonly SessionEntry[], repo: string): boolean {
  return sessions.some((entry) => entry.repo === repo && entry.state !== "apply_waiting");
}

/**
 * The repo's port pause, while it stands: its issue still sits in Paused, or its comment hasn't landed yet. A
 * pause that ended, by `retry` or any other move, or a repo whose app is no longer single-instance, forgets it.
 * With no snapshot this poll, the pause stays as it was.
 */
export async function openPortPause(input: {
  state: State;
  repo: string;
  app: App | null;
  snapshot: Snapshot | null;
  blocked: ReadonlySet<string>;
}): Promise<PortPause | null> {
  const { state, repo, app, snapshot, blocked } = input;
  const pause = await state.portPause(repo);
  if (pause === null || snapshot === null) return pause;
  const paused = blocked.has(pause.issue) || snapshot.issues.some((issue) => issue.id === pause.issue && issue.role === "paused");
  if (app !== null && paused) return pause;
  await state.writePortPause(repo, null);
  return null;
}
