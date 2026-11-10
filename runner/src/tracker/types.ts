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

/** One issue as `issue` returns it. */
export interface TrackerIssue extends SnapshotIssue {
  description: string;
  /** The creator's user ID. */
  creator: string;
  comments: TrackerComment[];
  /** The GitHub sync attachment's ID, or `null` when the issue isn't synced. */
  sync_attachment: string | null;
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
 * the runner uses so far; later tickets add `clearFlag`, `flag`, `file`, `relate`, `detach`, and `upload`.
 */
export interface Tracker {
  /** Every issue in a factory status or in the `intake` role. One filtered query per repo. */
  snapshot(repo: TrackerRepo): Promise<Snapshot>;
  /** One issue with its description, comments, and sync state. */
  issue(issue: IssueRef): Promise<TrackerIssue>;

  /** Only Lifecycle calls this. */
  move(issue: IssueRef, role: Role): Promise<void>;
  /**
   * A top-level comment. Flagged, it assigns the maintainer first. Unflagged on an issue the runner hasn't
   * flagged, it unsubscribes the maintainer first when they're subscribed. Fold lines become `+++`.
   */
  post(issue: IssueRef, comment: string, options: PostOptions): Promise<void>;
  /** Unsubscribes the maintainer, only when they're subscribed. */
  unsubscribe(issue: IssueRef): Promise<void>;
  /** Replaces the description with the brief, then a `+++ Report` fold that holds the report. */
  writeBrief(issue: IssueRef, brief: string, options: WriteBriefOptions): Promise<void>;
  /** Makes the duplicate relation and moves the issue to the `duplicate` role. Only Lifecycle calls this. */
  markDuplicate(issue: IssueRef, of: IssueRef): Promise<void>;

  /** Mints the session's Flight Deck Reader token. */
  sessionToken(session: TokenSession): Promise<string>;
  /** Revokes the session's Reader token. */
  revoke(session: TokenSession): Promise<void>;
}
