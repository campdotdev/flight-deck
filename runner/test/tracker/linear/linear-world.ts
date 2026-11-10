// The Linear adapter's test setup: a fake Linear, a repo on team SHA, and Linear-shaped nodes for its answers.
// The node builders follow Linear's public schema; the contract suite (FLD-116) replaces them with recordings.
import type { Role } from "../../../src/record/index.ts";
import { LinearTracker, type LinearIdentity, type TrackerRepo } from "../../../src/tracker/index.ts";
import { FakeLinear } from "./fake-linear.ts";

export const STATUSES: Record<Role, string> = {
  intake: "Triage",
  backlog: "Backlog",
  ready_to_plan: "Ready to plan",
  planning: "Planning",
  ready_to_build: "Ready to build",
  building: "Building",
  ready_to_check: "Ready to check",
  checking: "Checking",
  landed: "Landed",
  paused: "Paused",
  in_review: "In Review",
  done: "Done",
  canceled: "Canceled",
  duplicate: "Duplicate",
};

/** The status type Linear gives each of SHA's statuses. */
const TYPES: Record<string, string> = {
  Triage: "triage",
  Backlog: "backlog",
  "Ready to plan": "unstarted",
  Planning: "started",
  "Ready to build": "unstarted",
  Building: "started",
  "Ready to check": "unstarted",
  Checking: "started",
  Landed: "started",
  Paused: "started",
  "In Review": "started",
  Done: "completed",
  Canceled: "canceled",
  Duplicate: "duplicate",
};

export const repo: TrackerRepo = {
  name: "campdotdev/shaders",
  workspace: "campdotdev",
  team: "SHA",
  statuses: STATUSES,
  maintainer: "user-maintainer",
};

export const TEAM_ID = "team-sha";

/** The UUID Linear gives SHA's status of that name. */
export function stateId(name: string): string {
  return `state-${name.toLowerCase().replaceAll(" ", "-")}`;
}

export function state(name: string): { name: string; type: string } {
  return { name, type: TYPES[name] ?? "started" };
}

/** A UUID for a test issue number. */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** The fake, with both of campdotdev's apps, and the team query answered with SHA's statuses. */
export function world(identity: LinearIdentity = { kind: "flight_deck" }): { linear: FakeLinear; tracker: LinearTracker; logs: string[] } {
  const linear = FakeLinear.start();
  linear.apps.set("fd-client", "fd-secret");
  linear.apps.set("reader-client", "reader-secret");
  if (identity.kind === "setup_key") linear.accepted.add(identity.key);
  linear.on("FlightDeckTeam", teamReply(Object.values(STATUSES)));
  const logs: string[] = [];
  const tracker = new LinearTracker({
    identity,
    api: linear.url,
    apps: async (workspace) =>
      workspace === "campdotdev" ? { flight_deck: { id: "fd-client", secret: "fd-secret" }, reader: { id: "reader-client", secret: "reader-secret" } } : null,
    log: (message) => logs.push(message),
  });
  return { linear, tracker, logs };
}

export function teamReply(names: string[]) {
  return { data: { teams: { nodes: [{ id: TEAM_ID, key: "SHA", states: { nodes: names.map((name) => ({ id: stateId(name), name, type: TYPES[name] ?? "started" })) } }] } } };
}

export interface IssueNodeInput {
  n: number;
  status?: string;
  title?: string;
  assignee?: string | null;
  subscribers?: string[];
  parent?: string | null;
  children?: number;
  priority?: number;
  createdAt?: string;
  archivedAt?: string | null;
  /** The spans `stateHistory(last: 3)` returns. */
  spans?: { startedAt: string; endedAt: string | null }[];
}

/** An issue as `ISSUE_FIELDS` reads it. */
export function issueNode(input: IssueNodeInput) {
  return {
    id: uuid(input.n),
    identifier: `SHA-${input.n}`,
    title: input.title ?? `Issue ${input.n}`,
    url: `https://linear.app/campdotdev/issue/SHA-${input.n}/issue-${input.n}`,
    priority: input.priority ?? 0,
    createdAt: input.createdAt ?? "2026-11-01T09:00:00.000Z",
    archivedAt: input.archivedAt ?? null,
    state: state(input.status ?? "Planning"),
    assignee: input.assignee == null ? null : { id: input.assignee },
    parent: input.parent == null ? null : { id: input.parent },
    subscribers: { nodes: (input.subscribers ?? []).map((id) => ({ id })) },
    children: { nodes: Array.from({ length: input.children ?? 0 }, (_, i) => ({ id: `child-${input.n}-${i}` })) },
    stateHistory: { nodes: input.spans ?? [{ startedAt: "2026-11-02T09:00:00.000Z", endedAt: null }] },
  };
}

export interface CommentNodeInput {
  id: string;
  issue?: number;
  body?: string;
  createdAt: string;
  user?: string | null;
  externalUser?: string | null;
  syncedWith?: boolean;
  parent?: string | null;
}

export function commentNode(input: CommentNodeInput) {
  return {
    id: input.id,
    body: input.body ?? "A comment.",
    createdAt: input.createdAt,
    user: input.user === null ? null : { id: input.user ?? "user-maintainer" },
    externalUser: input.externalUser == null ? null : { id: input.externalUser },
    syncedWith: input.syncedWith === true ? [{ service: "github" }] : null,
    parent: input.parent == null ? null : { id: input.parent },
    ...(input.issue === undefined ? {} : { issue: { id: uuid(input.issue) } }),
  };
}

/** One page of a connection. */
export function page<T>(nodes: T[], next: string | null = null) {
  return { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes };
}
