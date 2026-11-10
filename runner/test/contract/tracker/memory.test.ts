// The Tracker contract suite's in-memory half. It runs in CI, so the in-memory adapter passes the same assertions
// that real Linear does when the maintainer runs the Linear half (`linear.test.ts`).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readRecord } from "../../../src/record/index.ts";
import { InMemoryTracker, type StatusType, type TrackerRepo } from "../../../src/tracker/index.ts";
import { trackerContract } from "./contract.ts";

const SHADERS = readRecord(readFileSync(join(import.meta.dir, "../../record/fixtures/shaders.toml"), "utf8"));
if (!SHADERS.ok) throw new Error("the Shaders fixture doesn't parse");
const statuses = SHADERS.record.tracker.statuses;

/** Shaders' statuses with the types Linear gives them. */
const TYPES: Record<string, StatusType> = {
  [statuses.intake]: "triage",
  [statuses.backlog]: "backlog",
  [statuses.ready_to_plan]: "unstarted",
  [statuses.ready_to_build]: "unstarted",
  [statuses.ready_to_check]: "unstarted",
  [statuses.planning]: "started",
  [statuses.building]: "started",
  [statuses.checking]: "started",
  [statuses.landed]: "started",
  [statuses.paused]: "started",
  [statuses.in_review]: "started",
  [statuses.done]: "completed",
  [statuses.canceled]: "canceled",
  [statuses.duplicate]: "duplicate",
};

trackerContract("the in-memory adapter", async () => {
  let now = new Date("2026-11-10T09:00:00Z");
  const tracker = new InMemoryTracker({ clock: () => now, appUser: "app-user" });
  tracker.addUser({ id: "app-user", name: "Flight Deck" });
  tracker.addUser({ id: "maintainer", name: "Hunter" });
  tracker.addTeam({ key: "SHA", name: "Shaders", statuses: Object.entries(TYPES).map(([name, type]) => ({ name, type })) });
  const repo: TrackerRepo = { name: "campdotdev/shaders", workspace: "campdotdev", team: "SHA", statuses, maintainer: "maintainer" };
  return {
    runner: tracker,
    maintainer: tracker.as("maintainer"),
    repo,
    async wait(ms) {
      now = new Date(now.getTime() + ms);
    },
    now: () => now,
    async syncedIssue() {
      // An issue Linear's GitHub Issues Sync made, in Triage, with a comment someone wrote on GitHub.
      const issue = tracker.addIssue({ team: "SHA", title: "A synced scratch issue", status: statuses.intake, creator: "maintainer", synced: true });
      const comment = tracker.addComment(issue.id, { author: "github-user", body: "A comment from GitHub.", synced: true });
      return { ref: { id: issue.id, repo }, comment: comment.id };
    },
    async tokenWorks(token) {
      return tracker.tokens.some((record) => record.token === token && !record.revoked);
    },
    async close() {},
  };
});
