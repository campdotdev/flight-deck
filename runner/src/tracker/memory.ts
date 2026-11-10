// The in-memory Tracker adapter. It keeps a Linear workspace in memory, models the Linear behavior the runner
// relies on, and records every write. Scenarios build their world through its `add*` methods and assert on
// `writes`. The Tracker contract suite checks the same behavior against real Linear.
import { ROLES, type Role } from "../record/index.ts";
import { briefDescription, plusFolds, unsigned } from "./folds.ts";
import { FACTORY_ROLES, roleOf } from "./roles.ts";
import { MintFailed, type LinearApp } from "./mint.ts";
import { TrackerUnavailable, type UnavailableReason } from "./unavailable.ts";
import {
  IssueNotFoundError,
  type Blocker,
  type BlockerIssue,
  type FiledIssue,
  type IssueDraft,
  type IssueRef,
  type RelationKind,
  type StatusType,
  type SyncedIssueRef,
  type TeamCheck,
  type UploadFile,
} from "./types.ts";
import type {
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

/** One write the runner made, in the order Linear would have seen it. `issue` is the identifier. */
export type TrackerWrite =
  | { kind: "move"; issue: string; status: string }
  | { kind: "assign"; issue: string; user: string }
  | { kind: "unassign"; issue: string }
  | { kind: "unsubscribe"; issue: string; user: string }
  | { kind: "comment"; issue: string; body: string }
  | { kind: "description"; issue: string; description: string }
  | { kind: "duplicate"; issue: string; of: string; status: string }
  | { kind: "detach"; issue: string; attachment: string }
  | { kind: "upload"; name: string; url: string }
  | { kind: "file"; issue: string; title: string; description: string; status: string }
  | { kind: "relate"; issue: string; other: string; relation: RelationKind };

/** A session's Reader token. */
export interface TokenRecord {
  session: string;
  token: string;
  revoked: boolean;
}

/** The runner's own Flight Deck app token for a workspace. */
export interface RunnerTokenRecord {
  workspace: string;
  token: string;
  revoked: boolean;
}

/** One mint, landed or refused. `session` is `null` for the runner's token and for a Reader retry. */
export interface MintRecord {
  app: LinearApp;
  workspace: string;
  session: string | null;
  ok: boolean;
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
  /** The GitHub sync attachment, which stays after a detach as the link to the GitHub issue. */
  sync_attachment: string | null;
  /** Whether the GitHub sync is on. */
  synced: boolean;
  duplicate_of: string | null;
  archived: boolean;
  /** The relations `relate` made from this issue, by the other issue's UUID. */
  relations: { kind: RelationKind; issue: string }[];
  /** The UUIDs of the issues that block this one. */
  blockers: string[];
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
  /** Whether the Flight Deck app can read the team and its issues. A private team it has no access to can't be. */
  readable: boolean;
}

/** The status types of an issue that's still open: not done, canceled, or a duplicate. */
const CLOSED_TYPES = new Set<StatusType>(["completed", "canceled", "duplicate"]);

/** The writes a scenario can make Linear refuse. */
export type RefusableWrite = "move" | "post" | "flag" | "clearFlag" | "unsubscribe" | "writeBrief" | "markDuplicate" | "file" | "relate" | "detach" | "upload";

/** Roles whose issues a snapshot returns: the factory statuses and `intake`. */
const SNAPSHOT_ROLES = new Set<Role>(["intake", ...FACTORY_ROLES]);

export class InMemoryTracker implements Tracker {
  /** Every write, in order. */
  readonly writes: TrackerWrite[] = [];
  /** Every Reader token minted for a session, in order. */
  readonly tokens: TokenRecord[] = [];
  /** Every Flight Deck app token minted for the runner, in order. */
  readonly runnerTokens: RunnerTokenRecord[] = [];
  /** The workspace of each revoke of the runner's own token, in order. */
  readonly runnerRevokes: string[] = [];
  /** Every mint of either app, in order, with whether it landed. */
  readonly mints: MintRecord[] = [];
  /** Each uploaded file's bytes, by the URL `upload` returned. */
  readonly uploads = new Map<string, Uint8Array>();

  private readonly clock: () => Date;
  /** The user every write acts as: the Flight Deck app user, or the maintainer for a hand run. */
  private readonly actor: string;
  private readonly teams = new Map<string, Team>();
  private readonly users = new Map<string, string>();
  private readonly issues = new Map<string, StoredIssue>();
  /** For each write, the refusals still to come, in order. */
  private readonly refusals = new Map<RefusableWrite, UnavailableReason[]>();
  /** Shared with every view `as` makes, so IDs stay unique. */
  private readonly ids = { last: 0 };
  /** `<app> <workspace>` for each app whose mints Linear refuses. */
  private readonly failing = new Set<string>();
  /** The tokens Linear rejects, as after an expiry or a revoke by hand. */
  private readonly rejected = new Set<string>();

  constructor(options: { clock: () => Date; appUser: string }) {
    this.clock = options.clock;
    this.actor = options.appUser;
  }

  /**
   * The same workspace, acting as another user, as `flight-deck apply` does with the maintainer's setup key. Its
   * writes land in this adapter's issues and records.
   */
  as(user: string): InMemoryTracker {
    const view = Object.create(this) as InMemoryTracker;
    Object.defineProperty(view, "actor", { value: user });
    return view;
  }

  // The world a scenario builds. None of these is a runner write.

  addUser(user: { id: string; name: string }): void {
    this.users.set(user.id, user.name);
  }

  /** A team. One with `readable: false` is a private team the Flight Deck app can see issues on but not read. */
  addTeam(team: { key: string; name: string; statuses: { name: string; type: StatusType }[]; readable?: boolean }): void {
    this.teams.set(team.key, { ...team, readable: team.readable ?? true, next: 1 });
  }

  /** The maintainer renames one of the team's statuses. Issues in it keep it under its new name. */
  renameStatus(teamKey: string, from: string, to: string): void {
    const team = this.team(teamKey);
    this.statusOf(team, from).name = to;
    for (const issue of this.issues.values()) if (issue.team === teamKey && issue.status === from) issue.status = to;
  }

  /** The team turns private, or its key changes, so the Flight Deck app can't read it. `true` undoes it. */
  setReadable(teamKey: string, readable: boolean): void {
    this.team(teamKey).readable = readable;
  }

  /** Files an issue as its creator, which subscribes them. */
  addIssue(input: NewIssue): StoredIssue {
    return this.create(input);
  }

  private create(input: NewIssue): StoredIssue {
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
      synced: input.synced === true,
      duplicate_of: null,
      archived: false,
      relations: [],
      blockers: [],
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

  /** The maintainer marks `blocker` as blocking `issueId`. */
  addBlocker(issueId: string, blocker: string): void {
    this.stored(issueId).blockers.push(this.stored(blocker).id);
  }

  /** The maintainer gives an issue a `duplicate` relation to `of`, or removes it with `null`. Its status stays. */
  setDuplicate(issueId: string, of: string | null): void {
    this.stored(issueId).duplicate_of = of === null ? null : this.stored(of).id;
  }

  /** A move the maintainer makes by hand, such as sending an issue. */
  setStatus(issueId: string, status: string): void {
    const issue = this.stored(issueId);
    this.statusOf(this.team(issue.team), status);
    issue.status = status;
    issue.status_since = this.now();
  }

  /** The maintainer deletes the issue. `issue` no longer finds it. */
  deleteIssue(issueId: string): void {
    this.issues.delete(this.stored(issueId).id);
  }

  /** The maintainer archives the issue. A snapshot no longer returns it. */
  archive(issueId: string): void {
    this.stored(issueId).archived = true;
  }

  /** The maintainer moves the issue to another team, into one of that team's statuses. */
  moveToTeam(issueId: string, team: string, status: string): void {
    const issue = this.stored(issueId);
    const to = this.team(team);
    this.statusOf(to, status);
    issue.team = to.key;
    issue.identifier = `${to.key}-${to.next++}`;
    issue.status = status;
    issue.status_since = this.now();
  }

  /**
   * Linear refuses the next `times` calls of the write, as a 5xx unless told otherwise, and records nothing
   * for them. The call after them lands.
   */
  refuse(write: RefusableWrite, options: { times?: number; reason?: UnavailableReason } = {}): void {
    const queue = this.refusals.get(write) ?? [];
    for (let i = 0; i < (options.times ?? 1); i++) queue.push(options.reason ?? "server");
    this.refusals.set(write, queue);
  }

  /** Linear takes the write again: any refusals still queued for it go. */
  accept(write: RefusableWrite): void {
    this.refusals.delete(write);
  }

  /** The stored issue, by UUID or identifier. */
  stored(id: string): StoredIssue {
    const issue = this.issues.get(id) ?? [...this.issues.values()].find((each) => each.identifier === id);
    if (issue === undefined) throw new IssueNotFoundError(id);
    return issue;
  }

  // Reads.

  async snapshot(repo: TrackerRepo, options: SnapshotOptions = {}): Promise<Snapshot> {
    const issues = [...this.issues.values()]
      .filter((issue) => issue.team === repo.team && !issue.archived)
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
    return {
      ...this.read(issue, ref.repo),
      team: issue.team,
      status_type: this.statusOf(this.team(issue.team), issue.status).type,
      description: issue.description,
      creator: issue.creator,
      comments: issue.comments.map((comment) => ({ ...comment })),
      synced: issue.synced,
      sync_attachment: issue.synced ? issue.sync_attachment : null,
      archived: issue.archived,
    };
  }

  async checkTeam(repo: TrackerRepo): Promise<TeamCheck> {
    const team = this.teams.get(repo.team);
    if (team === undefined || !team.readable) return { ok: false, reason: "unreadable" };
    const names = new Set(team.statuses.map((status) => status.name));
    const roles = ROLES.filter((role) => !names.has(repo.statuses[role]));
    return roles.length === 0 ? { ok: true } : { ok: false, reason: "missing", roles };
  }

  // Writes.

  async move(ref: IssueRef, role: Role): Promise<void> {
    this.refused("move");
    const issue = this.stored(ref.id);
    const status = this.statusFor(ref.repo, role);
    issue.status = status;
    issue.status_since = this.now();
    this.writes.push({ kind: "move", issue: issue.identifier, status });
  }

  async post(ref: IssueRef, comment: string, options: PostOptions): Promise<PostedComment> {
    this.refused("post");
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

  async flag(ref: IssueRef): Promise<void> {
    this.refused("flag");
    this.assign(this.stored(ref.id), ref.repo.maintainer);
  }

  async clearFlag(ref: IssueRef): Promise<void> {
    this.refused("clearFlag");
    const issue = this.stored(ref.id);
    if (issue.assignee !== null) {
      issue.assignee = null;
      this.writes.push({ kind: "unassign", issue: issue.identifier });
    }
    await this.unsubscribe(ref);
  }

  async unsubscribe(ref: IssueRef): Promise<void> {
    this.refused("unsubscribe");
    const issue = this.stored(ref.id);
    const user = ref.repo.maintainer;
    if (!issue.subscribers.includes(user)) return;
    issue.subscribers = issue.subscribers.filter((each) => each !== user);
    this.writes.push({ kind: "unsubscribe", issue: issue.identifier, user });
  }

  async writeBrief(ref: IssueRef, brief: string, options: WriteBriefOptions): Promise<void> {
    this.refused("writeBrief");
    const issue = this.stored(ref.id);
    issue.description = briefDescription(brief, issue.description, options.runnerWroteBrief);
    this.writes.push({ kind: "description", issue: issue.identifier, description: issue.description });
  }

  async markDuplicate(ref: IssueRef, of: IssueRef): Promise<void> {
    this.refused("markDuplicate");
    const issue = this.stored(ref.id);
    const original = this.stored(of.id);
    if (original.id === issue.id) throw new Error(`${issue.identifier} can't be a duplicate of itself`);
    const status = this.statusFor(ref.repo, "duplicate");
    issue.duplicate_of = original.id;
    issue.status = status;
    issue.status_since = this.now();
    this.writes.push({ kind: "duplicate", issue: issue.identifier, of: original.identifier, status });
  }

  async file(draft: IssueDraft, role: Role): Promise<FiledIssue> {
    this.refused("file");
    const status = this.statusFor(draft.repo, role);
    // Filing subscribes the creator, as Linear does.
    const issue = this.create({ team: draft.repo.team, title: draft.title, description: draft.description, status, creator: this.actor });
    this.writes.push({ kind: "file", issue: issue.identifier, title: issue.title, description: issue.description, status });
    return { id: issue.id, repo: draft.repo, identifier: issue.identifier, url: this.url(draft.repo, issue) };
  }

  async relate(ref: IssueRef, other: IssueRef, kind: RelationKind): Promise<void> {
    this.refused("relate");
    const issue = this.stored(ref.id);
    const to = this.stored(other.id);
    issue.relations.push({ kind, issue: to.id });
    this.writes.push({ kind: "relate", issue: issue.identifier, other: to.identifier, relation: kind });
  }

  async detach(ref: SyncedIssueRef): Promise<void> {
    this.refused("detach");
    const issue = this.stored(ref.id);
    if (!issue.synced || issue.sync_attachment !== ref.sync_attachment) throw new Error(`${issue.identifier} isn't synced through ${ref.sync_attachment}`);
    issue.synced = false;
    this.writes.push({ kind: "detach", issue: issue.identifier, attachment: ref.sync_attachment });
  }

  async upload(file: UploadFile): Promise<string> {
    this.refused("upload");
    // Linear's `fileUpload` returns a signed asset URL. The adapter strips the signature, as the Linear adapter does.
    const url = unsigned(`https://uploads.linear.app/workspace/${this.newId("upload")}/${encodeURIComponent(file.name)}?signature=signed`);
    this.uploads.set(url, file.data);
    this.writes.push({ kind: "upload", name: file.name, url });
    return url;
  }

  /**
   * Linear refuses every mint from the workspace's app until called again with `false`, as for a full token
   * pool, a rotated client secret, a deleted app, or an outage.
   */
  failMints(app: LinearApp, workspace: string, failing = true): void {
    if (failing) this.failing.add(`${app} ${workspace}`);
    else this.failing.delete(`${app} ${workspace}`);
  }

  /** Linear rejects the token from now on, so the next `viewer` test fails. */
  rejectToken(token: string): void {
    this.rejected.add(token);
  }

  async runnerToken(workspace: string): Promise<void> {
    // A token Linear rejects answers 401, and the adapter mints a new one.
    if (this.runnerTokens.some((record) => record.workspace === workspace && !record.revoked && !this.rejected.has(record.token))) return;
    this.mint("flight_deck", workspace, null);
    this.runnerTokens.push({ workspace, token: `app-${workspace}-${this.runnerTokens.length + 1}`, revoked: false });
  }

  async revokeRunnerToken(workspace: string): Promise<void> {
    this.runnerRevokes.push(workspace);
    for (const record of this.runnerTokens) if (record.workspace === workspace) record.revoked = true;
  }

  async sessionToken(session: TokenSession): Promise<string> {
    const held = this.tokens.find((record) => record.session === session.id && !record.revoked);
    // The `viewer` test: a token Linear still takes is returned as it is.
    if (held !== undefined && !this.rejected.has(held.token)) return held.token;
    this.mint("reader", session.repo.workspace, session.id);
    const token = `reader-${session.id}-${this.tokens.length + 1}`;
    if (held !== undefined) held.revoked = true;
    this.tokens.push({ session: session.id, token, revoked: false });
    return token;
  }

  async revoke(session: TokenSession): Promise<void> {
    for (const record of this.tokens) if (record.session === session.id) record.revoked = true;
  }

  async tryReaderMint(workspace: string): Promise<void> {
    this.mint("reader", workspace, null);
  }

  // Helpers.

  /** Records one mint, and throws `MintFailed` when the app's mints fail. */
  private mint(app: LinearApp, workspace: string, session: string | null): void {
    const ok = !this.failing.has(`${app} ${workspace}`);
    this.mints.push({ app, workspace, session, ok });
    if (!ok) throw new MintFailed(app, workspace);
  }

  private refused(write: RefusableWrite): void {
    const reason = this.refusals.get(write)?.shift();
    if (reason !== undefined) throw new TrackerUnavailable(reason, `Linear refused ${write}: ${reason}`);
  }

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
    const read = this.read(issue, repo);
    return read.role === null ? null : { ...read, role: read.role };
  }

  /** The fields a snapshot and `issue` share, with a `null` role for a status the repo's roles don't name. */
  private read(issue: StoredIssue, repo: TrackerRepo): Omit<SnapshotIssue, "role"> & { role: Role | null } {
    return {
      id: issue.id,
      repo,
      identifier: issue.identifier,
      title: issue.title,
      url: this.url(repo, issue),
      role: roleOf(repo, issue.status),
      status: issue.status,
      status_since: issue.status_since,
      assignee: issue.assignee,
      subscribers: [...issue.subscribers],
      parent: issue.parent,
      children: issue.children,
      priority: issue.priority,
      created_at: issue.created_at,
      ...this.blocking(issue, repo),
    };
  }

  /** `blockers` and `unblocks`, which Linear's filtered query reads only for an issue in `ready_to_plan`. */
  private blocking(issue: StoredIssue, repo: TrackerRepo): { blockers: Blocker[]; unblocks: number } {
    if (issue.team !== repo.team || roleOf(repo, issue.status) !== "ready_to_plan") return { blockers: [], unblocks: 0 };
    const blockers = issue.blockers.map((id): Blocker => {
      const blocker = this.blockerIssue(this.stored(id), repo);
      return blocker.readable ? { ...blocker, original: this.original(this.stored(id), repo) } : blocker;
    });
    const unblocks = [...this.issues.values()].filter(
      (other) =>
        other.blockers.includes(issue.id) &&
        this.open(other) &&
        other.blockers.every((id) => id === issue.id || !this.open(this.stored(id))),
    ).length;
    return { blockers, unblocks };
  }

  /** The issue a duplicate relation leads to, through further duplicates, or `null` with none or a loop. */
  private original(issue: StoredIssue, repo: TrackerRepo): BlockerIssue | null {
    const seen = new Set([issue.id]);
    let current = issue;
    while (current.duplicate_of !== null) {
      if (seen.has(current.duplicate_of)) return null;
      seen.add(current.duplicate_of);
      current = this.stored(current.duplicate_of);
      // The app can't read an unreadable issue's relations, so the chain stops there.
      if (!this.team(current.team).readable) break;
    }
    return current === issue ? null : this.blockerIssue(current, repo);
  }

  private blockerIssue(issue: StoredIssue, repo: TrackerRepo): BlockerIssue {
    if (!this.team(issue.team).readable) return { readable: false, identifier: issue.identifier };
    const { type } = this.statusOf(this.team(issue.team), issue.status);
    return { readable: true, identifier: issue.identifier, title: issue.title, url: this.url(repo, issue), status: issue.status, status_type: type };
  }

  /** An issue the app can't read counts as open. */
  private open(issue: StoredIssue): boolean {
    const team = this.team(issue.team);
    return !team.readable || !CLOSED_TYPES.has(this.statusOf(team, issue.status).type);
  }

  private url(repo: TrackerRepo, issue: StoredIssue): string {
    return `https://linear.app/${repo.workspace}/issue/${issue.identifier}`;
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
    return `${kind}-${++this.ids.last}`;
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

