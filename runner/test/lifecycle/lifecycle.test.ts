import { describe, expect, test } from "bun:test";
import { CAUSES, Lifecycle, type Cause } from "../../src/lifecycle/index.ts";
import { ROLES, type Role } from "../../src/record/index.ts";
import type { IssueRef, Tracker } from "../../src/tracker/index.ts";

/** Spec 1's move table, as roles, written out from the spec rather than read from the code. */
const ALLOWED: [Role, Role, Cause][] = [
  ["ready_to_plan", "planning", "take"],
  ["ready_to_plan", "paused", "pause_before_take"],
  ["planning", "ready_to_build", "handoff"],
  ["planning", "paused", "pause"],
  ["planning", "duplicate", "duplicate"],
  ["planning", "ready_to_plan", "requeue"],
  ["paused", "ready_to_plan", "answer"],
  ["paused", "ready_to_build", "answer"],
  ["paused", "ready_to_check", "answer"],
];

const ref: IssueRef = {
  id: "issue-1",
  repo: {
    name: "campdotdev/shaders",
    workspace: "campdotdev",
    team: "SHA",
    statuses: Object.fromEntries(ROLES.map((role) => [role, role])) as Record<Role, string>,
    maintainer: "maintainer",
  },
};
const original: IssueRef = { ...ref, id: "issue-2" };

/** A Tracker that records the two calls Lifecycle may make. */
function recordingTracker() {
  const calls: string[] = [];
  const tracker = {
    move: async (issue: IssueRef, role: Role) => void calls.push(`move ${issue.id} ${role}`),
    markDuplicate: async (issue: IssueRef, of: IssueRef) => void calls.push(`markDuplicate ${issue.id} ${of.id}`),
  } as unknown as Tracker;
  return { calls, lifecycle: new Lifecycle(tracker) };
}

describe("allowed moves", () => {
  test.each(ALLOWED)("%s to %s for %s", async (from, to, cause) => {
    const { calls, lifecycle } = recordingTracker();
    const result = await lifecycle.move({ ...ref, role: from }, to, cause, { of: original });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([to === "duplicate" ? "markDuplicate issue-1 issue-2" : `move issue-1 ${to}`]);
  });

  test("a duplicate without the issue it duplicates is a violation", async () => {
    const { calls, lifecycle } = recordingTracker();
    const result = await lifecycle.move({ ...ref, role: "planning" }, "duplicate", "duplicate");
    expect(result).toEqual({ ok: false, violation: "planning to duplicate needs the issue it duplicates" });
    expect(calls).toEqual([]);
  });
});

const disallowed: [Role, Role, Cause][] = ROLES.flatMap((from) =>
  ROLES.flatMap((to) =>
    CAUSES.filter((cause) => !ALLOWED.some((row) => row[0] === from && row[1] === to && row[2] === cause)).map(
      (cause): [Role, Role, Cause] => [from, to, cause],
    ),
  ),
);

describe("every other move is a violation", () => {
  test("the table leaves out every other move", () => {
    expect(disallowed.length).toBe(ROLES.length * ROLES.length * CAUSES.length - ALLOWED.length);
  });

  test.each(disallowed)("%s to %s for %s", async (from, to, cause) => {
    const { calls, lifecycle } = recordingTracker();
    const result = await lifecycle.move({ ...ref, role: from }, to, cause, { of: original });
    expect(result).toEqual({ ok: false, violation: `${from} to ${to} is not a move for ${cause}` });
    expect(calls).toEqual([]);
  });
});

describe("allows", () => {
  test("answers whether any cause allows a move, for the Outbox's check", () => {
    const lifecycle = recordingTracker().lifecycle;
    expect(lifecycle.allows("planning", "ready_to_build")).toBe(true);
    expect(lifecycle.allows("planning", "building")).toBe(false);
    expect(lifecycle.allows("paused", "ready_to_plan")).toBe(true);
  });
});
