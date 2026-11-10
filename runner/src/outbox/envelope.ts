// The envelope every outbox shares (overview, spec 1's "The envelope"), and the checks `apply` makes on it.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Lifecycle } from "../lifecycle/index.ts";
import { ROLES, type Role } from "../record/index.ts";
import type { Stage } from "../state/index.ts";

export interface Outcome {
  version: string;
  stage: Stage;
  move: Role;
}

export interface Envelope {
  outcome: Outcome;
  /** `summary.md`, or `null` when the session left none. */
  summary: string | null;
  /** The handoff file's name and text, such as `brief.md`. */
  handoff: { name: string; text: string };
}

/** The handoff file each move names. */
const HANDOFF_FILES: Partial<Record<Role, string>> = { ready_to_build: "brief.md", paused: "pause.md" };
const HANDOFF_NAMES = new Set(["brief.md", "pause.md", "claims.md", "verdict.md"]);
/** The moves each stage's outbox may make. */
const STAGE_MOVES: Partial<Record<Stage, readonly Role[]>> = { plan: ["ready_to_build", "paused", "duplicate"] };
/** The moves this Outbox applies so far. FLD-95 adds `paused`, and FLD-97 adds `duplicate` and follow-up issues. */
const APPLIES: readonly Role[] = ["ready_to_build"];

export type EnvelopeResult = { ok: true; envelope: Envelope } | { ok: false; rule: string };

export interface CheckContext {
  version: string;
  stage: Stage;
  /** The issue's role now. */
  role: Role;
  lifecycle: Lifecycle;
}

/** Reads the outbox and checks it (spec 1, "Checks"). The first broken rule fails it. */
export async function readEnvelope(outbox: string, context: CheckContext): Promise<EnvelopeResult> {
  const fail = (rule: string): EnvelopeResult => ({ ok: false, rule });
  const names = await readdir(outbox).catch(() => null);
  if (names === null) return fail("the outbox is missing");
  if (!names.includes("outcome.json")) return fail("the outbox holds no outcome.json");

  let outcome: Record<string, unknown>;
  try {
    outcome = JSON.parse(await readFile(join(outbox, "outcome.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return fail("outcome.json isn't JSON");
  }
  if (typeof outcome !== "object" || outcome === null || Array.isArray(outcome)) return fail("outcome.json isn't an object");
  if (outcome.version !== context.version) {
    return fail(`outcome.json's version ${String(outcome.version)} isn't the running version ${context.version}`);
  }
  if (outcome.stage !== context.stage) return fail(`outcome.json's stage ${String(outcome.stage)} isn't the session's stage ${context.stage}`);
  const move = outcome.move;
  if (typeof move !== "string" || !(ROLES as readonly string[]).includes(move)) return fail(`outcome.json's move ${String(move)} isn't a role`);
  const role = move as Role;
  if (!(STAGE_MOVES[context.stage] ?? []).includes(role)) return fail(`${context.stage} can't move an issue to ${role}`);
  if (!context.lifecycle.allows(context.role, role)) return fail(`Lifecycle doesn't allow ${context.role} to ${role}`);
  if (!APPLIES.includes(role)) return fail(`the Outbox can't apply a move to ${role} yet`);

  const extraKey = Object.keys(outcome).find((key) => !["version", "stage", "move"].includes(key));
  if (extraKey !== undefined) return fail(`outcome.json holds ${extraKey}, which a move to ${role} doesn't take`);

  const handoffName = HANDOFF_FILES[role];
  const handoffs = names.filter((name) => HANDOFF_NAMES.has(name));
  if (handoffName === undefined || !handoffs.includes(handoffName)) return fail(`a move to ${role} needs ${handoffName ?? "a handoff file"}`);
  if (handoffs.length > 1) return fail(`the outbox holds ${handoffs.length} handoff files: ${handoffs.join(", ")}`);
  const stray = names.find((name) => !["outcome.json", "summary.md", "media", "follow-ups", ...handoffs].includes(name));
  if (stray !== undefined) return fail(`${stray} isn't part of the outbox's envelope`);

  const text = await readFile(join(outbox, handoffName), "utf8");
  if (handoffName === "brief.md") {
    const rule = briefRule(text);
    if (rule !== null) return fail(rule);
  }
  const summary = names.includes("summary.md") ? await readFile(join(outbox, "summary.md"), "utf8") : null;
  return { ok: true, envelope: { outcome: { version: context.version, stage: context.stage, move: role }, summary, handoff: { name: handoffName, text } } };
}

/** The broken rule in a brief, or `null`. */
function briefRule(brief: string): string | null {
  if (/^(?:\+\+\+|>>>)[ \t]+Report[ \t]*$/m.test(brief)) return "brief.md holds a Report fold line, which the next re-plan would take for the report";
  const unaccepted = keyInterfaceBreaks(brief).find((bullet) => !bullet.accepted);
  if (unaccepted !== undefined) return `brief.md's Key interfaces lists a break of ${unaccepted.contract} that isn't marked (accepted)`;
  return null;
}

/** The bullets in a brief's `## Key interfaces` whose second part starts with "break" (ADR 0026). */
function keyInterfaceBreaks(brief: string): { contract: string; accepted: boolean }[] {
  const section = /^## Key interfaces[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(brief)?.[1] ?? "";
  return [...section.matchAll(/^- (`[^`]+`): (.*)$/gm)]
    .filter(([, , second]) => /^break\b/.test(second ?? ""))
    .map(([, contract, second]) => ({ contract: contract ?? "", accepted: /^break \(accepted\)/.test(second ?? "") }));
}
