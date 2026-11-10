// The replies an open pause starts with (spec 1, "Pauses", ADR 0019). Every comment posted after the pause
// comment counts, and a snapshot may have read one before the pause's move landed, while answers skipped the
// issue. So when the pause lands, its replies come from one read of the issue.
import type { Reply } from "../state/index.ts";
import type { TrackerIssue } from "../tracker/index.ts";

/** Each comment on the issue created after `commentAt`, oldest first, as a pause's reply. */
export function repliesAfter(issue: Pick<TrackerIssue, "comments">, commentAt: string): Reply[] {
  return issue.comments
    .filter((comment) => comment.created_at > commentAt)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map(({ id, author, created_at, body, synced }) => ({ id, author, created_at, body, synced }));
}
