// The Tracker port: the only module that reaches Linear. Callers speak in roles, and each adapter maps a
// role to the team's status name through the record's `[tracker.statuses]`.
import type { Role } from "../record/index.ts";

/** What a Tracker call needs to know about the repo an issue belongs to. */
export interface TrackerRepo {
  /** `owner/repo`. */
  name: string;
  /** The Linear workspace's URL key, such as `campdotdev`. */
  workspace: string;
  /** The team key, such as `SHA`. */
  team: string;
  /** The record's `[tracker.statuses]`, or the registration's copy of it. */
  statuses: Record<Role, string>;
  /** The Linear user ID of the maintainer the runner flags in this workspace. */
  maintainer: string;
}

/** One issue, by Linear's UUID or its identifier, in its repo. */
export interface IssueRef {
  id: string;
  repo: TrackerRepo;
}

/** An issue as `snapshot` returns it. Field names follow spec 1's. */
export interface SnapshotIssue extends IssueRef {
  /** Linear's UUID. */
  id: string;
  /** Such as `SHA-12`. */
  identifier: string;
  title: string;
  url: string;
  role: Role;
  /** The team's name for the issue's status. */
  status: string;
  /** ISO time the issue entered its current status. */
  status_since: string;
  /** The assignee's user ID, or `null`. */
  assignee: string | null;
  subscribers: string[];
  /** The parent issue's UUID, or `null`. */
  parent: string | null;
  /** The number of sub-issues. */
  children: number;
  /** Linear's priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: number;
  created_at: string;
}

export interface Snapshot {
  /** Every issue in a factory status or in the `intake` role. */
  issues: SnapshotIssue[];
  /**
   * The comments on those issues created at or after the snapshot's `since`, top-level and replies alike,
   * oldest first, each with its body as Linear returns it now.
   */
  comments: SnapshotComment[];
}

export interface SnapshotOptions {
  /** The repo's snapshot cursor: an ISO creation time. `null` or absent returns every comment. */
  since?: string | null;
}

export interface SnapshotComment extends TrackerComment {
  /** The UUID of the issue the comment sits on. */
  issue: string;
}

/** A comment `post` made. */
export interface PostedComment {
  id: string;
  /** ISO time. */
  created_at: string;
}

export interface TrackerComment {
  id: string;
  /** The author's user ID. */
  author: string;
  body: string;
  created_at: string;
  /** The parent comment's ID for a reply, or `null`. */
  parent: string | null;
  /** Whether the comment came through the GitHub sync. */
  synced: boolean;
}

/** Linear's status types. */
export type StatusType = "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled" | "duplicate";

/**
 * One issue as `issue` returns it. It may sit on another team, or in a status the repo's roles don't name, such
 * as the issue a duplicate's `of` names, so its role may be `null`.
 */
export interface TrackerIssue extends Omit<SnapshotIssue, "role"> {
  role: Role | null;
  /** The team key. */
  team: string;
  status_type: StatusType;
  description: string;
  /** The creator's user ID. */
  creator: string;
  comments: TrackerComment[];
  /** Whether the issue is synced with a GitHub issue: its `syncedWith` holds a `github` entry (ADR 0008). */
  synced: boolean;
  /** The GitHub sync attachment's ID while the issue is synced, else `null`. */
  sync_attachment: string | null;
}

/** `issue` throws this when Linear has no issue by that ID, or the identity can't read it. */
export class IssueNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`no issue ${id}`);
    this.name = "IssueNotFoundError";
  }
}

/** A synced issue, with the sync attachment `detach` turns off. */
export interface SyncedIssueRef extends IssueRef {
  sync_attachment: string;
}

/** An issue `file` files: its team comes from the repo. */
export interface IssueDraft {
  repo: TrackerRepo;
  title: string;
  description: string;
}

/** An issue `file` filed. */
export interface FiledIssue extends IssueRef {
  identifier: string;
  url: string;
}

/** The relations `relate` makes. Spec 4 adds blocking. */
export type RelationKind = "related";

/** A file `upload` uploads. */
export interface UploadFile {
  /** The file name, such as `before.png`. */
  name: string;
  contentType: string;
  data: Uint8Array;
}

export interface PostOptions {
  /** Assign the maintainer before the comment, so the comment reaches them. */
  flag: boolean;
}

export interface WriteBriefOptions {
  /** Whether issue memory holds a brief the runner wrote for this issue. */
  runnerWroteBrief: boolean;
}

/** A session the Reader token is for. */
export interface TokenSession {
  id: string;
  repo: TrackerRepo;
}

/**
 * The Tracker's operations. Spec 1 builds the overview's whole interface. This version holds the operations
 * the runner uses so far; FLD-106 adds `flag`.
 */
export interface Tracker {
  /**
   * Every issue in a factory status or in the `intake` role, and the comments on them since the repo's
   * snapshot cursor. One filtered query per repo.
   */
  snapshot(repo: TrackerRepo, options?: SnapshotOptions): Promise<Snapshot>;
  /** One issue with its description, comments, and sync state. */
  issue(issue: IssueRef): Promise<TrackerIssue>;

  /** Only Lifecycle calls this. */
  move(issue: IssueRef, role: Role): Promise<void>;
  /**
   * A top-level comment. Flagged, it assigns the maintainer first. Unflagged on an issue the runner hasn't
   * flagged, it unsubscribes the maintainer first when they're subscribed. Fold lines become `+++`.
   */
  post(issue: IssueRef, comment: string, options: PostOptions): Promise<PostedComment>;
  /**
   * Clears the assignee, then unsubscribes the maintainer when they're subscribed, because Linear keeps an
   * assignee subscribed (ADR 0011).
   */
  clearFlag(issue: IssueRef): Promise<void>;
  /** Unsubscribes the maintainer, only when they're subscribed. */
  unsubscribe(issue: IssueRef): Promise<void>;
  /** Replaces the description with the brief, then a `+++ Report` fold that holds the report. */
  writeBrief(issue: IssueRef, brief: string, options: WriteBriefOptions): Promise<void>;
  /** Makes the duplicate relation and moves the issue to the `duplicate` role. Only Lifecycle calls this. */
  markDuplicate(issue: IssueRef, of: IssueRef): Promise<void>;
  /**
   * Files an issue in the role's status, because Linear sends an issue created through the API to the team's
   * default status otherwise (ADR 0013). It sets no label, priority, assignee, or delegate (ADR 0006).
   */
  file(draft: IssueDraft, role: Role): Promise<FiledIssue>;
  relate(issue: IssueRef, other: IssueRef, kind: RelationKind): Promise<void>;
  /**
   * Turns off the issue's GitHub sync with `issueExternalSyncDisable`. The attachment stays as the link to the
   * GitHub issue (ADR 0008).
   */
  detach(issue: SyncedIssueRef): Promise<void>;
  /** Uploads a file with `fileUpload` and returns its asset URL without any `?signature=` (ADR 0019). */
  upload(file: UploadFile): Promise<string>;

  /** Mints the session's Flight Deck Reader token. */
  sessionToken(session: TokenSession): Promise<string>;
  /** Revokes the session's Reader token. */
  revoke(session: TokenSession): Promise<void>;
}
