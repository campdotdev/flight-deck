// The in-memory Tracker adapter. It keeps a Linear workspace in memory, models the Linear behavior the runner
// relies on, and records every write. Scenarios build their world through its `add*` methods and assert on
// `writes`. The Tracker contract suite checks the same behavior against real Linear.
import type { Role } from "../record/index.ts";
import { briefDescription, plusFolds } from "./folds.ts";
import { FACTORY_ROLES, roleOf } from "./roles.ts";
import type {
  IssueRef,
  PostedComment,
  PostOptions,
  Snapshot,
  SnapshotComment,
  SnapshotIssue,
  SnapshotOptions,
  TokenSession,
  Tracker,
  TrackerComment,
  TrackerIssue,
  TrackerRepo,
  WriteBriefOptions,
} from "./types.ts";

/** Linear's status types. */
export type StatusType = "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled" | "duplicate";

/** One write the runner made, in the order Linear would have seen it. `issue` is the identifier. */
export type TrackerWrite =
  | { kind: "move"; issue: string; status: string }
  | { kind: "assign"; issue: string; user: string }
  | { kind: "unassign"; issue: string }
  | { kind: "unsubscribe"; issue: string; user: string }
  | { kind: "comment"; issue: string; body: string }
  | { kind: "description"; issue: string; description: string }
  | { kind: "duplicate"; issue: string; of: string; status: string };

export interface TokenRecord {
  session: string;
  token: string;
  revoked: boolean;
}

/** An issue as the in-memory workspace stores it. */
export interface StoredIssue {
  id: string;
  identifier: string;
  team: string;
  title: string;
  description: string;
  status: string;
  status_since: string;
  creator: string;
  assignee: string | null;
  subscribers: string[];
  parent: string | null;
  children: number;
  priority: number;
  created_at: string;
  comments: TrackerComment[];
  sync_attachment: string | null;
  duplicate_of: string | null;
}

export interface NewIssue {
  team: string;
  title: string;
  /** A status name on the team. */
  status: string;
  creator: string;
  description?: string;
  assignee?: string;
  priority?: number;
  parent?: string;
  children?: number;
  /** Whether the issue is synced with a GitHub issue. */
  synced?: boolean;
}

export interface NewComment {
  author: string;
  body: string;
  parent?: string;
  synced?: boolean;
}

interface Team {
  key: string;
  name: string;
  statuses: { name: string; type: StatusType }[];
  next: number;
}

/** Roles whose issues a snapshot returns: the factory statuses and `intake`. */
const SNAPSHOT_ROLES = new Set<Role>(["intake", ...FACTORY_ROLES]);

export class InMemoryTracker implements Tracker {
  /** Every write, in order. */
  readonly writes: TrackerWrite[] = [];
  /** Every Reader token minted, in order. */
  readonly tokens: TokenRecord[] = [];

  private readonly clock: () => Date;
  /** The user every write acts as: the Flight Deck app user, or the maintainer for a hand run. */
  private readonly actor: string;
  private readonly teams = new Map<string, Team>();
  private readonly users = new Map<string, string>();
  private readonly issues = new Map<string, StoredIssue>();
  private ids = 0;

  constructor(options: { clock: () => Date; appUser: string }) {
    this.clock = options.clock;
    this.actor = options.appUser;
  }

  // The world a scenario builds. None of these is a runner write.

  addUser(user: { id: string; name: string }): void {
    this.users.set(user.id, user.name);
  }

  addTeam(team: { key: string; name: string; statuses: { name: string; type: StatusType }[] }): void {
    this.teams.set(team.key, { ...team, next: 1 });
  }

  /** Files an issue as its creator, which subscribes them. */
  addIssue(input: NewIssue): StoredIssue {
    const team = this.team(input.team);
    this.statusOf(team, input.status);
    const now = this.now();
    const subscribers = [input.creator];
    if (input.assignee !== undefined && input.assignee !== input.creator) subscribers.push(input.assignee);
    const issue: StoredIssue = {
      id: this.newId("issue"),
      identifier: `${team.key}-${team.next++}`,
      team: team.key,
      title: input.title,
      description: input.description ?? "",
      status: input.status,
      status_since: now,
      creator: input.creator,
      assignee: input.assignee ?? null,
      subscribers,
      parent: input.parent ?? null,
      children: input.children ?? 0,
      priority: input.priority ?? 0,
      created_at: now,
      comments: [],
      sync_attachment: input.synced === true ? this.newId("attachment") : null,
      duplicate_of: null,
    };
    this.issues.set(issue.id, issue);
    return issue;
  }

  /** A user's comment, which subscribes them. */
  addComment(issueId: string, input: NewComment): TrackerComment {
    return this.comment(this.stored(issueId), input.author, input.body, input.parent ?? null, input.synced ?? false);
  }

  /** A user edits a comment's body. */
  editComment(commentId: string, body: string): void {
    const comment = [...this.issues.values()].flatMap((issue) => issue.comments).find((each) => each.id === commentId);
    if (comment === undefined) throw new Error(`no comment ${commentId}`);
    comment.body = body;
  }

  /** The maintainer sets or clears an assignee by hand. Assigning subscribes the assignee. */
  setAssignee(issueId: string, user: string | null): void {
    const issue = this.stored(issueId);
    issue.assignee = user;
    if (user !== null && !issue.subscribers.includes(user)) issue.subscribers.push(user);
  }

  /** A move the maintainer makes by hand, such as sending an issue. */
  setStatus(issueId: string, status: string): void {
    const issue = this.stored(issueId);
    this.statusOf(this.team(issue.team), status);
    issue.status = status;
    issue.status_since = this.now();
  }

  /** The stored issue, by UUID or identifier. */
  stored(id: string): StoredIssue {
    const issue = this.issues.get(id) ?? [...this.issues.values()].find((each) => each.identifier === id);
    if (issue === undefined) throw new Error(`no issue ${id}`);
    return issue;
  }

  // Reads.

  async snapshot(repo: TrackerRepo, options: SnapshotOptions = {}): Promise<Snapshot> {
    const issues = [...this.issues.values()]
      .filter((issue) => issue.team === repo.team)
      .map((issue) => this.snapshotIssue(issue, repo))
      .filter((issue): issue is SnapshotIssue => issue !== null && SNAPSHOT_ROLES.has(issue.role));
    const since = options.since ?? null;
    const comments: SnapshotComment[] = issues
      .flatMap((issue) => this.stored(issue.id).comments.map((comment) => ({ ...comment, issue: issue.id })))
      .filter((comment) => since === null || comment.created_at >= since)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return { issues, comments };
  }

  async issue(ref: IssueRef): Promise<TrackerIssue> {
    const issue = this.stored(ref.id);
    const read = this.snapshotIssue(issue, ref.repo);
    if (read === null) throw new Error(`${issue.identifier}'s status ${issue.status} has no role`);
    return {
      ...read,
      description: issue.description,
      creator: issue.creator,
      comments: issue.comments.map((comment) => ({ ...comment })),
      sync_attachment: issue.sync_attachment,
    };
  }

  // Writes.

  async move(ref: IssueRef, role: Role): Promise<void> {
    const issue = this.stored(ref.id);
    const status = this.statusFor(ref.repo, role);
    issue.status = status;
    issue.status_since = this.now();
    this.writes.push({ kind: "move", issue: issue.identifier, status });
  }

  async post(ref: IssueRef, comment: string, options: PostOptions): Promise<PostedComment> {
    const issue = this.stored(ref.id);
    const maintainer = ref.repo.maintainer;
    if (options.flag) {
      this.assign(issue, maintainer);
    } else if (issue.assignee !== maintainer) {
      // An issue the runner flagged keeps the maintainer assigned and subscribed, so the comment reaches them.
      await this.unsubscribe(ref);
    }
    const posted = this.comment(issue, this.actor, plusFolds(comment), null, false);
    return { id: posted.id, created_at: posted.created_at };
  }

  async clearFlag(ref: IssueRef): Promise<void> {
    const issue = this.stored(ref.id);
    if (issue.assignee !== null) {
      issue.assignee = null;
      this.writes.push({ kind: "unassign", issue: issue.identifier });
    }
    await this.unsubscribe(ref);
  }

  async unsubscribe(ref: IssueRef): Promise<void> {
    const issue = this.stored(ref.id);
    const user = ref.repo.maintainer;
    if (!issue.subscribers.includes(user)) return;
    issue.subscribers = issue.subscribers.filter((each) => each !== user);
    this.writes.push({ kind: "unsubscribe", issue: issue.identifier, user });
  }

  async writeBrief(ref: IssueRef, brief: string, options: WriteBriefOptions): Promise<void> {
    const issue = this.stored(ref.id);
    issue.description = briefDescription(brief, issue.description, options.runnerWroteBrief);
    this.writes.push({ kind: "description", issue: issue.identifier, description: issue.description });
  }

  async markDuplicate(ref: IssueRef, of: IssueRef): Promise<void> {
    const issue = this.stored(ref.id);
    const original = this.stored(of.id);
    if (original.id === issue.id) throw new Error(`${issue.identifier} can't be a duplicate of itself`);
    const status = this.statusFor(ref.repo, "duplicate");
    issue.duplicate_of = original.id;
    issue.status = status;
    issue.status_since = this.now();
    this.writes.push({ kind: "duplicate", issue: issue.identifier, of: original.identifier, status });
  }

  async sessionToken(session: TokenSession): Promise<string> {
    const token = `reader-${session.id}-${this.tokens.length + 1}`;
    this.tokens.push({ session: session.id, token, revoked: false });
    return token;
  }

  async revoke(session: TokenSession): Promise<void> {
    for (const record of this.tokens) if (record.session === session.id) record.revoked = true;
  }

  // Helpers.

  private assign(issue: StoredIssue, user: string): void {
    issue.assignee = user;
    // Linear subscribes an assignee.
    if (!issue.subscribers.includes(user)) issue.subscribers.push(user);
    this.writes.push({ kind: "assign", issue: issue.identifier, user });
  }

  private comment(issue: StoredIssue, author: string, body: string, parent: string | null, synced: boolean): TrackerComment {
    const comment: TrackerComment = { id: this.newId("comment"), author, body, created_at: this.now(), parent, synced };
    issue.comments.push(comment);
    // Linear subscribes a user who comments. A comment through the GitHub sync has no Linear user.
    if (!synced && !issue.subscribers.includes(author)) issue.subscribers.push(author);
    if (author === this.actor) this.writes.push({ kind: "comment", issue: issue.identifier, body });
    return comment;
  }

  private snapshotIssue(issue: StoredIssue, repo: TrackerRepo): SnapshotIssue | null {
    const role = roleOf(repo, issue.status);
    if (role === null) return null;
    return {
      id: issue.id,
      repo,
      identifier: issue.identifier,
      title: issue.title,
      url: `https://linear.app/${repo.workspace}/issue/${issue.identifier}`,
      role,
      status: issue.status,
      status_since: issue.status_since,
      assignee: issue.assignee,
      subscribers: [...issue.subscribers],
      parent: issue.parent,
      children: issue.children,
      priority: issue.priority,
      created_at: issue.created_at,
    };
  }

  private statusFor(repo: TrackerRepo, role: Role): string {
    const status = repo.statuses[role];
    this.statusOf(this.team(repo.team), status);
    return status;
  }

  private statusOf(team: Team, name: string): { name: string; type: StatusType } {
    const status = team.statuses.find((each) => each.name === name);
    if (status === undefined) throw new Error(`team ${team.key} has no status ${name}`);
    return status;
  }

  private team(key: string): Team {
    const team = this.teams.get(key);
    if (team === undefined) throw new Error(`no team ${key}`);
    return team;
  }

  private newId(kind: string): string {
    return `${kind}-${++this.ids}`;
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

