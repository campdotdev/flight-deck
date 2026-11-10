import type { Role } from "../record/index.ts";
import type { Stage } from "../state/index.ts";

/** The working status each stage takes its issue to. */
export const WORKING: Partial<Record<Stage, Role>> = { plan: "planning" };

/** A stage runs at most this many sessions per stay in its working status: the first, and one fresh retry (ADR 0002). */
export const MAX_ATTEMPTS = 2;
