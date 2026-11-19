// `state/trouble.json`: each trouble cause the runner knows about (spec 1, "Trouble issues", ADR 0011).
import type { Role } from "../record/index.ts";

/** Spec 1's trouble causes. */
export type TroubleCause =
  | "claude_login"
  | "claude_login_soon"
  | "claude_code_version"
  | "github_token"
  | "linear_token"
  | "linear_login"
  | "missing_status"
  | "team_unreadable"
  | "shared_team"
  | "credentials";

/** What the runner saw at the last poll the cause was open, for the trouble issue's text, and the cleared comment's. */
export interface TroubleFacts {
  /** `owner/repo`, for a repo's cause, or the repo whose fetch failed. */
  repo?: string;
  workspace?: string;
  /** The team key. */
  team?: string;
  /** For `missing_status`: each missing status, in the record's role order. */
  missing?: { role: Role; name: string }[];
  /** The installed Claude Code version, and the oldest this version runs. */
  version?: string;
  minVersion?: string;
  /** The error the runner saw. */
  error?: string;
  /** `credentials.env`'s mode, such as `0640`. */
  mode?: string;
}

/** One trouble issue the runner filed for a cause, in one repo's `intake` role. */
export interface TroubleIssue {
  repo: string;
  /** Linear's UUID. */
  id: string;
  identifier: string;
  url: string;
  title: string;
  /** Whether `Tracker.flag` landed. A flag Linear didn't take is tried again at the next poll. */
  flagged: boolean;
  /** The comment the runner owes the issue, kept until Linear takes it, so a failed write is tried again. */
  pending?: TroubleComment;
}

/**
 * A comment owed to a trouble issue: the cleared comment, or the reopened one, which flags the issue again when
 * it's no longer assigned at the poll that posts it. `statusLine` is fixed when the comment is owed, so each try
 * posts the same text. `since` is the ISO time the cause cleared or opened again.
 * `tried` is set once a post was tried, so the next try first looks for a comment whose response was lost.
 */
export type TroubleComment = ({ kind: "cleared"; sentence: string } | { kind: "reopened" }) & { statusLine: string; since: string; tried: boolean };

/**
 * One cause. `open` is false once it cleared. A cleared entry stays while one of its issues is still open, so
 * the cause opening again comments on that issue instead of filing another.
 */
export interface TroubleEntry {
  cause: TroubleCause;
  /** Which occurrence of the cause: `runner`, a repo's name, or a workspace and team key for `shared_team`. */
  id: string;
  /** What it stops: every session on the Mac, or the named repos' sessions. */
  scope: "runner" | "workspace" | "repo";
  /** The repos it affects. Empty for a cause scoped to the runner. */
  repos: string[];
  open: boolean;
  /** ISO time it last opened. */
  since: string;
  facts: TroubleFacts;
  issues: TroubleIssue[];
  /**
   * Each repo's UUID for a trouble issue being filed, saved before the create. A create can land though its
   * response is lost, so the next poll looks the UUID up and keeps the issue it finds rather than filing another.
   */
  filing?: Record<string, string>;
}
