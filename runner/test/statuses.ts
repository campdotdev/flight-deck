// The statuses every test team uses: Shaders' names for each role, with the status type Linear gives each.
import type { Role } from "../src/record/index.ts";
import type { StatusType } from "../src/tracker/index.ts";

/** Shaders' statuses, with the status type Linear gives each. */
export const STATUSES: Record<Role, [string, StatusType]> = {
  intake: ["Triage", "triage"],
  backlog: ["Backlog", "backlog"],
  ready_to_plan: ["Ready to plan", "unstarted"],
  planning: ["Planning", "started"],
  ready_to_build: ["Ready to build", "unstarted"],
  building: ["Building", "started"],
  ready_to_check: ["Ready to check", "unstarted"],
  checking: ["Checking", "started"],
  landed: ["Landed", "started"],
  paused: ["Paused", "started"],
  in_review: ["In Review", "started"],
  done: ["Done", "completed"],
  canceled: ["Canceled", "canceled"],
  duplicate: ["Duplicate", "duplicate"],
};

/** Each role's status name, as a record's `[tracker.statuses]` names it. */
export const STATUS_NAMES = Object.fromEntries(Object.entries(STATUSES).map(([role, [name]]) => [role, name])) as Record<Role, string>;

/** The status type Linear gives each status name. */
export const STATUS_TYPES: Record<string, StatusType> = Object.fromEntries(Object.values(STATUSES));
