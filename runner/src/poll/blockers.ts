// The blocker test before plan's take (spec 1's "Starts", ADRs 0002 and 0004). Poll runs it on each sent issue
// before it orders them, and while held, because a pause starts no session.
import type { Blocker, BlockerIssue, ReadableIssue, SnapshotIssue } from "../tracker/index.ts";

/**
 * `take`: every blocker is done. `pause`: a blocker was canceled or is a duplicate of nothing, which pauses the
 * issue even when another blocker is still open. `wait`: some blocker is open, and `open` lists each one.
 */
export type BlockerTest =
  | { kind: "take" }
  | { kind: "pause"; canceled: ReadableIssue[]; nothing: ReadableIssue[] }
  | { kind: "wait"; open: BlockerIssue[] };

/**
 * A blocker is done when its status type is `completed`, so one in Landed, a `started` status, isn't: its code
 * sits on a spec branch. A blocker with an `original` counts as its original, tested before the canceled test.
 * One the app can't read counts as open.
 */
export function blockerTest(issue: SnapshotIssue): BlockerTest {
  const canceled: ReadableIssue[] = [];
  const nothing: ReadableIssue[] = [];
  const open: BlockerIssue[] = [];
  for (const blocker of issue.blockers) {
    const counted = countsAs(blocker);
    if (!counted.readable) open.push(blocker);
    // The pause names the issue whose status stopped plan: a duplicate blocker's original, when it has one.
    else if (counted.status_type === "canceled") canceled.push(counted);
    else if (counted.status_type === "duplicate") nothing.push(counted);
    else if (counted.status_type !== "completed") open.push(blocker);
  }
  if (canceled.length > 0 || nothing.length > 0) return { kind: "pause", canceled, nothing };
  return open.length > 0 ? { kind: "wait", open } : { kind: "take" };
}

/** The issue a blocker counts as: its original when it has one. */
function countsAs(blocker: Blocker): BlockerIssue {
  return blocker.readable && blocker.original !== null ? blocker.original : blocker;
}
