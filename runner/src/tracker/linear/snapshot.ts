// The snapshot: one filtered query per repo per poll, paged under the 10,000-point cap (spec 1, "Polls"). Its
// pages read the team's issues in the snapshot roles, then the comments since the repo's cursor, then, for the
// sent issues only, their blockers and the issues they block, a few issues to a request. Duplicate chains are
// followed in batches by ID. No read is ever one per issue.
import type { Role } from "../../record/index.ts";
import { FACTORY_ROLES, roleOf } from "../roles.ts";
import type { Blocker, BlockerIssue, ReadableIssue, Snapshot, SnapshotComment, SnapshotIssue, StatusType, TrackerComment, TrackerRepo } from "../types.ts";
import * as Q from "./queries.ts";

/** One GraphQL read for the repo's workspace. `partial` keeps data that came back beside errors. */
export type Read = <T>(query: string, variables: Record<string, unknown>, partial?: boolean) => Promise<T>;

export interface Page<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}

/** An issue as `ISSUE_FIELDS` reads it. */
export interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority: number;
  createdAt: string;
  archivedAt: string | null;
  state: { name: string; type: string };
  assignee: { id: string } | null;
  parent: { id: string } | null;
  subscribers: { nodes: { id: string }[] };
  children: { nodes: { id: string }[] };
  stateHistory: { nodes: { startedAt: string; endedAt: string | null }[] };
}

export interface CommentNode {
  id: string;
  body: string;
  createdAt: string;
  user: { id: string } | null;
  externalUser: { id: string } | null;
  syncedWith: { service: string }[] | null;
  parent: { id: string } | null;
}

/** Roles whose issues a snapshot returns: the factory statuses and `intake`. */
const SNAPSHOT_ROLES: readonly Role[] = ["intake", ...FACTORY_ROLES];

/** The status types of an issue that isn't open. */
const CLOSED_TYPES = new Set(["completed", "canceled", "duplicate"]);

export async function snapshot(read: Read, repo: TrackerRepo, since: string | null): Promise<Snapshot> {
  const team = { key: { eq: repo.team } };
  const statuses = [...new Set(SNAPSHOT_ROLES.map((role) => repo.statuses[role]))];
  const issueFilter = { team, state: { name: { in: statuses } } };

  const issues: SnapshotIssue[] = [];
  for (const node of await pages<IssueNode>(read, Q.SNAPSHOT_ISSUES, "issues", { filter: issueFilter })) {
    const fields = issueFields(node, repo);
    // A snapshot never returns an archived issue, nor one whose status reads back as a role it doesn't return.
    if (node.archivedAt !== null || fields.role === null || !SNAPSHOT_ROLES.includes(fields.role)) continue;
    issues.push({ ...fields, role: fields.role, blockers: [], unblocks: 0 });
  }

  const ids = new Set(issues.map((issue) => issue.id));
  const commentFilter: Record<string, unknown> = { issue: issueFilter };
  if (since !== null) commentFilter.createdAt = { gte: since };
  const comments: SnapshotComment[] = [];
  for (const node of await pages<CommentNode & { issue: { id: string } | null }>(read, Q.COMMENTS, "comments", { filter: commentFilter })) {
    if (node.issue === null || !ids.has(node.issue.id)) continue;
    if (since !== null && node.createdAt < since) continue;
    comments.push({ ...comment(node), issue: node.issue.id });
  }
  comments.sort((a, b) => a.created_at.localeCompare(b.created_at));

  const sent = issues.filter((issue) => issue.role === "ready_to_plan");
  const blocks = await blocking(read, sent.map((issue) => issue.id));
  for (const issue of sent) {
    const found = blocks.get(issue.id);
    if (found === undefined) continue;
    issue.blockers = found.blockers;
    issue.unblocks = found.unblocks;
  }
  return { issues, comments };
}

/** The fields a snapshot issue and `issue` share, with a `null` role for a status the repo's roles don't name. */
export function issueFields(node: IssueNode, repo: TrackerRepo): Omit<SnapshotIssue, "role" | "blockers" | "unblocks"> & { role: Role | null } {
  return {
    id: node.id,
    repo,
    identifier: node.identifier,
    title: node.title,
    url: node.url,
    role: roleOf(repo, node.state.name),
    status: node.state.name,
    status_since: statusSince(node),
    assignee: node.assignee?.id ?? null,
    subscribers: node.subscribers.nodes.map((user) => user.id),
    parent: node.parent?.id ?? null,
    children: node.children.nodes.length,
    priority: node.priority,
    created_at: node.createdAt,
  };
}

/**
 * When the issue entered its status: the start of its open span in `stateHistory`, or the latest span's start,
 * or its creation for an issue with no span. The contract suite pins the order `last` reads spans in.
 */
function statusSince(node: IssueNode): string {
  const spans = node.stateHistory.nodes;
  const open = spans.find((span) => span.endedAt === null);
  if (open !== undefined) return open.startedAt;
  const latest = spans.map((span) => span.startedAt).sort().at(-1);
  return latest ?? node.createdAt;
}

/**
 * A comment as the Tracker returns it. It came through the GitHub sync when Linear reports an `externalUser` or
 * a `syncedWith` entry for it (spec 1). The contract suite pins which of the two the real API sets.
 */
export function comment(node: CommentNode): TrackerComment {
  const synced = node.externalUser !== null || (node.syncedWith ?? []).length > 0;
  return {
    id: node.id,
    author: node.user?.id ?? node.externalUser?.id ?? "",
    body: node.body,
    created_at: node.createdAt,
    parent: node.parent?.id ?? null,
    synced,
  };
}

/** Every page of a connection at the root of a query. */
async function pages<T>(read: Read, query: string, root: string, variables: Record<string, unknown>): Promise<T[]> {
  const nodes: T[] = [];
  let after: string | null = null;
  for (;;) {
    const data: Record<string, Page<T>> = await read(query, { ...variables, after });
    const page = data[root]!;
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage || page.pageInfo.endCursor === null) return nodes;
    after = page.pageInfo.endCursor;
  }
}

interface BlockerNode {
  id: string;
  inverseRelations: { nodes: { type: string; issue: LinkedIssue | null }[] };
  relations: {
    nodes: {
      type: string;
      relatedIssue: { id: string; state: { type: string } | null; inverseRelations: { nodes: { type: string; issue: { id: string; state: { type: string } | null } | null }[] } } | null;
    }[];
  };
}

/** An issue a blocker test reads. `state` is `null` when the app can see the issue but not read it. */
interface LinkedIssue {
  id: string;
  identifier: string;
  title: string | null;
  url: string | null;
  state: { name: string; type: string } | null;
  relations: { nodes: { type: string; relatedIssue: { id: string; identifier: string } | null }[] } | null;
}

/**
 * Each sent issue's `blockers` and `unblocks` (spec 1, ADRs 0002 and 0004). A blocker is an issue with a
 * `blocks` relation to it. `unblocks` counts the open issues it blocks that have no other open blocker. An
 * issue the app can see but not read counts as open. The contract suite pins which way the `blocks` and
 * `duplicate` relations point, and what Linear returns for an issue the app can't read.
 */
export async function blocking(read: Read, ids: string[]): Promise<Map<string, { blockers: Blocker[]; unblocks: number }>> {
  const nodes: BlockerNode[] = [];
  for (let i = 0; i < ids.length; i += Q.BLOCKER_CHUNK) {
    const data = await read<{ issues: { nodes: (BlockerNode | null)[] } }>(Q.BLOCKERS, { ids: ids.slice(i, i + Q.BLOCKER_CHUNK) }, true);
    for (const node of data.issues.nodes) if (node !== null) nodes.push(node);
  }

  const links = new Map<string, LinkedIssue>();
  for (const node of nodes) for (const relation of node.inverseRelations.nodes) if (relation.issue !== null) links.set(relation.issue.id, relation.issue);
  await followDuplicates(read, links);

  const result = new Map<string, { blockers: Blocker[]; unblocks: number }>();
  for (const node of nodes) {
    const blockers = node.inverseRelations.nodes
      .filter((relation) => relation.type === "blocks" && relation.issue !== null)
      .map((relation): Blocker => {
        const issue = relation.issue!;
        const blocker = blockerIssue(issue);
        return blocker.readable ? { ...blocker, original: original(issue, links) } : blocker;
      });
    const unblocks = node.relations.nodes.filter((relation) => {
      const blocked = relation.relatedIssue;
      if (relation.type !== "blocks" || blocked === null || !open(blocked.state)) return false;
      return blocked.inverseRelations.nodes.every((other) => other.type !== "blocks" || other.issue === null || other.issue.id === node.id || !open(other.issue.state));
    }).length;
    result.set(node.id, { blockers, unblocks });
  }
  return result;
}

/** Reads every issue a `duplicate` relation leads to that isn't read yet, in batches, until none is left. */
async function followDuplicates(read: Read, links: Map<string, LinkedIssue>): Promise<void> {
  const unreadable = new Set<string>();
  for (;;) {
    const wanted = new Map<string, string>();
    for (const issue of links.values()) {
      const target = duplicateOf(issue);
      if (target !== null && !links.has(target.id) && !unreadable.has(target.id)) wanted.set(target.id, target.identifier);
    }
    if (wanted.size === 0) return;
    const batch = [...wanted.keys()].slice(0, Q.ISSUE_BATCH);
    const data = await read<{ issues: { nodes: (LinkedIssue | null)[] } }>(Q.DUPLICATE_LINKS, { ids: batch }, true);
    for (const node of data.issues.nodes) if (node !== null) links.set(node.id, node);
    // An issue the batch didn't return is one the app can't read, so a chain stops there.
    for (const id of batch) {
      if (!links.has(id)) {
        unreadable.add(id);
        links.set(id, { id, identifier: wanted.get(id)!, title: null, url: null, state: null, relations: null });
      }
    }
  }
}

/** The issue a `duplicate` relation of this one points to: the issue it duplicates. */
function duplicateOf(issue: LinkedIssue): { id: string; identifier: string } | null {
  return issue.relations?.nodes.find((relation) => relation.type === "duplicate" && relation.relatedIssue !== null)?.relatedIssue ?? null;
}

/** The first issue down the duplicate chain that isn't a duplicate, or `null` with no relation or a loop. */
function original(issue: LinkedIssue, links: Map<string, LinkedIssue>): BlockerIssue | null {
  const seen = new Set([issue.id]);
  let current = issue;
  for (;;) {
    const next = duplicateOf(current);
    if (next === null) break;
    if (seen.has(next.id)) return null;
    seen.add(next.id);
    current = links.get(next.id) ?? { id: next.id, identifier: next.identifier, title: null, url: null, state: null, relations: null };
    // The app can't read an unreadable issue's relations, so the chain stops there.
    if (current.state === null) break;
  }
  return current === issue ? null : blockerIssue(current);
}

function blockerIssue(issue: LinkedIssue): BlockerIssue {
  if (issue.state === null || issue.title === null || issue.url === null) return { readable: false, identifier: issue.identifier };
  const readable: ReadableIssue = {
    readable: true,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    status: issue.state.name,
    status_type: issue.state.type as StatusType,
  };
  return readable;
}

/** An issue the app can't read counts as open. */
function open(state: { type: string } | null): boolean {
  return state === null || !CLOSED_TYPES.has(state.type);
}
