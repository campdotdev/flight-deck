// The envelope every outbox shares (overview, spec 1's "The envelope"), and the checks `apply` makes on it.
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Cause, Lifecycle } from "../lifecycle/index.ts";
import { ROLES, type Role } from "../record/index.ts";
import { codeLines, foldTitles, opensAsBrief } from "../tracker/index.ts";
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
  /** Each image the posted files name, once, in order: its file name in `media/` and the bytes the check read. */
  images: { name: string; data: Uint8Array }[];
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
/** The cause an outbox makes each move with. */
const MOVE_CAUSES: Partial<Record<Role, Cause>> = { ready_to_build: "handoff", paused: "pause", duplicate: "duplicate" };
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
  /** The issue's role now, or `null` when its status maps to none. */
  role: Role | null;
  lifecycle: Lifecycle;
  /** Whether the move to this role already landed, so the issue already left the status the move starts from. */
  moved(to: Role): boolean;
}

/** Reads the outbox and checks it (spec 1, "Checks"). The first broken rule fails it. */
export async function readEnvelope(outbox: string, context: CheckContext): Promise<EnvelopeResult> {
  const fail = (rule: string): EnvelopeResult => ({ ok: false, rule });
  const names = (await readdir(outbox).catch(() => null))?.sort() ?? null;
  if (names === null) return fail("the outbox is missing");
  if (!names.includes("outcome.json")) return fail("the outbox holds no outcome.json");

  const outcomeText = await readRegularFile(join(outbox, "outcome.json"));
  if (outcomeText === null) return fail("outcome.json isn't a regular file");
  let outcome: Record<string, unknown>;
  try {
    outcome = JSON.parse(outcomeText) as Record<string, unknown>;
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
  const cause = MOVE_CAUSES[role];
  if (!context.moved(role)) {
    if (context.role === null) return fail(`the issue's status maps to no role, so Lifecycle allows no move to ${role}`);
    if (cause === undefined || !context.lifecycle.allows(context.role, role, cause)) return fail(`Lifecycle doesn't allow ${context.role} to ${role}`);
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
  // The runner reads and posts what the folders hold, so neither may be a symlink to a folder the session can't read.
  for (const folder of ["media", "follow-ups"]) {
    if (names.includes(folder) && !(await lstat(join(outbox, folder)).catch(() => null))?.isDirectory()) return fail(`${folder} isn't a folder`);
  }

  let handoff: Envelope["handoff"] = null;
  if (handoffName !== null) {
    const text = await readRegularFile(join(outbox, handoffName));
    if (text === null) return fail(`${handoffName} isn't a regular file`);
    if (text.trim() === "") return fail(`${handoffName} is empty`);
    if (handoffName === "brief.md") {
      const rule = briefRule(text);
      if (rule !== null) return fail(rule);
    }
    handoff = { name: handoffName, text };
  }
  const followUps = names.includes("follow-ups") ? await readFollowUps(join(outbox, "follow-ups")) : [];
  if (typeof followUps === "string") return fail(followUps);
  let summary: string | null = null;
  if (names.includes("summary.md")) {
    summary = await readRegularFile(join(outbox, "summary.md"));
    if (summary === null) return fail("summary.md isn't a regular file");
  }

  // Every image a posted file names is a bare file name in media/.
  const posted = [
    ...(summary === null ? [] : [{ name: "summary.md", text: summary }]),
    ...(handoff === null ? [] : [handoff]),
    ...followUps.map((followUp) => ({ name: followUp.name, text: followUp.description })),
  ];
  const media = names.includes("media") ? await readdir(join(outbox, "media"), { withFileTypes: true }).catch(() => []) : [];
  const mediaRuleBroken = mediaRule(posted, new Set(media.filter((entry) => entry.isFile()).map((entry) => entry.name)));
  if (mediaRuleBroken !== null) return fail(mediaRuleBroken);
  const images: Envelope["images"] = [];
  for (const name of new Set(posted.flatMap((file) => imageTargets(file.text)))) {
    const data = await readRegularBytes(join(outbox, "media", name));
    if (data === null) return fail(`media/${name} isn't a regular file`);
    images.push({ name, data });
  }
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
    const text = await readRegularFile(join(folder, entry.name));
    if (text === null) return `${name} isn't a regular file`;
    const [first = "", ...rest] = text.split("\n");
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
    if (!context.lifecycle.allows("paused", move as Role, "answer")) return `Lifecycle doesn't allow paused to ${move}, which the answer ${word} names`;
    if (!(ANSWER_MOVES[context.stage] ?? []).includes(move as Role)) return `${context.stage}'s answers can't move an issue to ${move}`;
    checked.push({ word, does: does.trim(), move: move as Role });
  }
  return { answers: checked, needs };
}

/**
 * The file's text with LF line ends, or `null` when it isn't a regular file or can't be read. Fold lines and
 * headings are found line by line, and a CRLF file's `\r` would hide each one from the checks and from `flattenFolds`.
 */
async function readRegularFile(path: string): Promise<string | null> {
  const data = await readRegularBytes(path);
  return data === null ? null : Buffer.from(data).toString("utf8").replaceAll("\r\n", "\n");
}

/**
 * The file's bytes, or `null` when it isn't a regular file or can't be read. A session could leave a symlink to a
 * file it can't read itself, and the runner would post that file to Linear, so the open never follows one (ADR
 * 0007). `O_NONBLOCK` keeps a named pipe from holding the open. The Outbox posts and uploads these bytes, and never
 * opens the path again, so a file the session swaps in after the check never reaches Linear.
 */
async function readRegularBytes(path: string): Promise<Uint8Array | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    if (!(await handle.stat()).isFile()) return null;
    return new Uint8Array(await handle.readFile());
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** The broken rule in a brief, or `null`. */
function briefRule(brief: string): string | null {
  // A re-plan finds the brief above the Report fold by this heading, even when issue memory doesn't record that
  // the runner wrote it, such as after a brief write whose response was lost.
  if (!opensAsBrief(brief)) return "brief.md doesn't open with ## Summary, the heading a re-plan finds the brief by";
  if (foldTitles(brief).includes("Report")) return "brief.md holds a Report fold line, which the next re-plan would take for the report";
  const unaccepted = keyInterfaceBreaks(brief).find((bullet) => !bullet.accepted);
  if (unaccepted !== undefined) return `brief.md's Key interfaces lists a break of ${unaccepted.contract} that isn't marked (accepted)`;
  return null;
}

/**
 * The bullets in a brief's `## Key interfaces` whose second part starts with "break" (ADR 0026). The check is the
 * runner's last guard against a break no one accepted, so it reads loosely: any list marker, a name with or
 * without code font, and "break" in any case and as the start of a longer word such as "breaking". A bullet with
 * no colon counts as all second part. Lines in a fenced code block are neither headings nor bullets. Only
 * "break (accepted)" accepts.
 */
function keyInterfaceBreaks(brief: string): { contract: string; accepted: boolean }[] {
  const breaks: { contract: string; accepted: boolean }[] = [];
  let inSection = false;
  for (const { line, code } of codeLines(brief)) {
    if (code) continue;
    if (/^#{1,2}[ \t]/.test(line)) {
      inSection = /^## Key interfaces[ \t]*$/.test(line);
      continue;
    }
    const item = inSection ? /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(.*)$/.exec(line)?.[1] : undefined;
    if (item === undefined) continue;
    const shaped = /^(`[^`]+`|[^:`]+?)[ \t]*:[ \t]*(.*)$/.exec(item);
    const contract = (shaped?.[1] ?? item).trim();
    const second = (shaped?.[2] ?? item).replace(/^[*_]+/, "");
    if (/^break/i.test(second)) breaks.push({ contract, accepted: /^break \(accepted\)/.test(second) });
  }
  return breaks;
}
