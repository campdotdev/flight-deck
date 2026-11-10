// The envelope every outbox shares (overview, spec 1's "The envelope"), and the checks `apply` makes on it.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Lifecycle } from "../lifecycle/index.ts";
import { ROLES, type Role } from "../record/index.ts";
import type { Answer, Stage } from "../state/index.ts";
import { imageTargets, mediaRule } from "./media.ts";

export interface Outcome {
  version: string;
  stage: Stage;
  move: Role;
  /** A pause's answers. */
  answers?: Answer[];
  /** A pause's need: `answer` when a one-word reply decides it, `help` when the maintainer acts first. */
  needs?: "answer" | "help";
  /** A duplicate's original: an issue identifier. The Outbox checks that it names an open issue on the team. */
  of?: string;
}

export interface Envelope {
  outcome: Outcome;
  /** `summary.md`, or `null` when the session left none. */
  summary: string | null;
  /** The handoff file's name and text, such as `brief.md`, or `null` for a duplicate, which holds none. */
  handoff: { name: string; text: string } | null;
  /** `follow-ups/<n>.md`, in the order of their numbers. */
  followUps: FollowUp[];
  /** Each image file name the posted files name, once, in order. Each one sits in `media/`. */
  images: string[];
}

/** One follow-up issue: `follow-ups/<n>.md`, with `# <title>` on its first line and the description after. */
export interface FollowUp {
  /** Its path in the outbox, such as `follow-ups/1.md`. */
  name: string;
  title: string;
  description: string;
}

/** The handoff file each move names. */
const HANDOFF_FILES: Partial<Record<Role, string>> = { ready_to_build: "brief.md", paused: "pause.md" };
const HANDOFF_NAMES = new Set(["brief.md", "pause.md", "claims.md", "verdict.md"]);
/** The moves each stage's outbox may make. */
const STAGE_MOVES: Partial<Record<Stage, readonly Role[]>> = { plan: ["ready_to_build", "paused", "duplicate"] };
/** The moves each stage's pause answers may name. Plan's name only `ready_to_plan`, because plan rewrites the brief (ADR 0026). */
const ANSWER_MOVES: Partial<Record<Stage, readonly Role[]>> = { plan: ["ready_to_plan"] };
/** The most answers a pause offers (ADR 0019). */
const MAX_ANSWERS = 3;
/** The keys `outcome.json` takes for each move. */
const OUTCOME_KEYS: Partial<Record<Role, readonly string[]>> = {
  ready_to_build: ["version", "stage", "move"],
  paused: ["version", "stage", "move", "answers", "needs"],
  duplicate: ["version", "stage", "move", "of"],
};

export type EnvelopeResult = { ok: true; envelope: Envelope } | { ok: false; rule: string };

export interface CheckContext {
  version: string;
  stage: Stage;
  /** The issue's role now. */
  role: Role;
  lifecycle: Lifecycle;
  /** Whether an earlier apply on the same folder made the move, so the issue already sits where the outbox moves it. */
  moved: boolean;
}

/** Reads the outbox and checks it (spec 1, "Checks"). The first broken rule fails it. */
export async function readEnvelope(outbox: string, context: CheckContext): Promise<EnvelopeResult> {
  const fail = (rule: string): EnvelopeResult => ({ ok: false, rule });
  const names = (await readdir(outbox).catch(() => null))?.sort() ?? null;
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
  if (context.moved ? context.role !== role : !context.lifecycle.allows(context.role, role)) {
    return fail(context.moved ? `the issue left ${role} after an earlier apply moved it there` : `Lifecycle doesn't allow ${context.role} to ${role}`);
  }
  if (!(role in OUTCOME_KEYS)) return fail(`the Outbox can't apply a move to ${role} yet`);

  const extraKey = Object.keys(outcome).find((key) => !(OUTCOME_KEYS[role] ?? []).includes(key));
  if (extraKey !== undefined) return fail(`outcome.json holds ${extraKey}, which a move to ${role} doesn't take`);
  const checkedOutcome: Outcome = { version: context.version, stage: context.stage, move: role };
  if (role === "paused") {
    const pause = pauseRule(outcome, context);
    if (typeof pause === "string") return fail(pause);
    Object.assign(checkedOutcome, pause);
  }
  if (role === "duplicate") {
    if (typeof outcome.of !== "string" || outcome.of.trim() === "") return fail("a move to duplicate needs of, an issue identifier");
    checkedOutcome.of = outcome.of.trim();
  }

  // Exactly one handoff file, the one the move names. A duplicate holds none.
  const handoffName = HANDOFF_FILES[role] ?? null;
  const handoffs = names.filter((name) => HANDOFF_NAMES.has(name));
  if (handoffName === null && handoffs.length > 0) return fail(`a move to ${role} holds no handoff file, but the outbox holds ${handoffs.join(", ")}`);
  if (handoffName !== null && !handoffs.includes(handoffName)) return fail(`a move to ${role} needs ${handoffName}`);
  if (handoffs.length > 1) return fail(`the outbox holds ${handoffs.length} handoff files: ${handoffs.join(", ")}`);
  const stray = names.find((name) => !["outcome.json", "summary.md", "media", "follow-ups", ...handoffs].includes(name));
  if (stray !== undefined) return fail(`${stray} isn't part of the outbox's envelope`);

  let handoff: Envelope["handoff"] = null;
  if (handoffName !== null) {
    const text = await readFile(join(outbox, handoffName), "utf8");
    if (handoffName === "brief.md") {
      const rule = briefRule(text);
      if (rule !== null) return fail(rule);
    }
    handoff = { name: handoffName, text };
  }
  const followUps = names.includes("follow-ups") ? await readFollowUps(join(outbox, "follow-ups")) : [];
  if (typeof followUps === "string") return fail(followUps);
  const summary = names.includes("summary.md") ? await readFile(join(outbox, "summary.md"), "utf8") : null;

  // Every image a posted file names is a bare file name in media/.
  const posted = [
    ...(summary === null ? [] : [{ name: "summary.md", text: summary }]),
    ...(handoff === null ? [] : [handoff]),
    ...followUps.map((followUp) => ({ name: followUp.name, text: followUp.description })),
  ];
  const media = names.includes("media") ? await readdir(join(outbox, "media"), { withFileTypes: true }).catch(() => []) : [];
  const mediaRuleBroken = mediaRule(posted, new Set(media.filter((entry) => entry.isFile()).map((entry) => entry.name)));
  if (mediaRuleBroken !== null) return fail(mediaRuleBroken);
  const images = [...new Set(posted.flatMap((file) => imageTargets(file.text)))];
  return { ok: true, envelope: { outcome: checkedOutcome, summary, handoff, followUps, images } };
}

/** Each `follow-ups/<n>.md`, in the order of their numbers, or the broken rule. */
async function readFollowUps(folder: string): Promise<FollowUp[] | string> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => null);
  if (entries === null) return "follow-ups isn't a folder";
  const numbered: [number, FollowUp][] = [];
  for (const entry of entries) {
    const name = `follow-ups/${entry.name}`;
    const match = /^([1-9]\d*)\.md$/.exec(entry.name);
    if (match === null || !entry.isFile()) return `${name} isn't named follow-ups/<n>.md`;
    const [first = "", ...rest] = (await readFile(join(folder, entry.name), "utf8")).split("\n");
    const title = /^# (.*)$/.exec(first)?.[1]?.trim() ?? "";
    if (title === "") return `${name} doesn't open with # <title>`;
    numbered.push([Number(match[1]), { name, title, description: rest.join("\n").trim() }]);
  }
  return numbered.sort(([a], [b]) => a - b).map(([, followUp]) => followUp);
}

/** A pause's checked `answers` and `needs`, or the broken rule. */
function pauseRule(outcome: Record<string, unknown>, context: CheckContext): { answers: Answer[]; needs: "answer" | "help" } | string {
  const { answers, needs } = outcome;
  if (needs !== "answer" && needs !== "help") return `outcome.json's needs ${String(needs)} isn't answer or help`;
  if (!Array.isArray(answers)) return "a pause's outcome.json needs answers, a list";
  if (answers.length > MAX_ANSWERS) return `a pause offers at most ${MAX_ANSWERS} answers, not ${answers.length}`;
  if (answers.length === 0 && needs !== "help") return "a pause with no answers sets needs to help";
  const checked: Answer[] = [];
  for (const answer of answers as unknown[]) {
    if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return "each answer is an object with word, does, and move";
    const { word, does, move, ...rest } = answer as Record<string, unknown>;
    const extra = Object.keys(rest)[0];
    if (extra !== undefined) return `an answer holds ${extra}, which an answer doesn't take`;
    if (typeof word !== "string" || !/^\p{Ll}+$/u.test(word)) return `the answer word ${JSON.stringify(word)} isn't one lowercase word`;
    if (checked.some((each) => each.word === word)) return `the answer word ${word} appears twice`;
    if (typeof does !== "string" || does.trim() === "") return `the answer ${word} doesn't say what it does`;
    if (typeof move !== "string" || !(ROLES as readonly string[]).includes(move)) return `the answer ${word}'s move ${String(move)} isn't a role`;
    if (!context.lifecycle.allows("paused", move as Role)) return `Lifecycle doesn't allow paused to ${move}, which the answer ${word} names`;
    if (!(ANSWER_MOVES[context.stage] ?? []).includes(move as Role)) return `${context.stage}'s answers can't move an issue to ${move}`;
    checked.push({ word, does: does.trim(), move: move as Role });
  }
  return { answers: checked, needs };
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
