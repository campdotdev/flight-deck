import { ROLES, type Role } from "../record/index.ts";
import type { TrackerRepo } from "./types.ts";

/** The eight roles setup adds (ADR 0006, glossary: factory status). */
export const FACTORY_ROLES: readonly Role[] = [
  "ready_to_plan",
  "planning",
  "ready_to_build",
  "building",
  "ready_to_check",
  "checking",
  "landed",
  "paused",
];

/** The queues, where the maintainer sends an issue and the runner takes it from. */
export const QUEUE_ROLES: readonly Role[] = ["ready_to_plan", "ready_to_build", "ready_to_check"];

/** The working statuses, where a session runs. */
export const WORKING_ROLES: readonly Role[] = ["planning", "building", "checking"];

/** The role a status name reads back as. `intake` wins when it shares a status with `backlog` (ADR 0013). */
export function roleOf(repo: TrackerRepo, status: string): Role | null {
  return ROLES.find((role) => repo.statuses[role] === status) ?? null;
}
