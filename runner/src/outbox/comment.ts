// The comment the Outbox posts for each outbox, in ADR 0019's shape: the status line, the rest of
// `summary.md`, then a `+++ Details` fold holding the handoff and the footer.
import type { Role } from "../record/index.ts";
import { flattenFolds, fold } from "../tracker/index.ts";

/** The longest status line, in Unicode code points: "under 80 characters". */
export const STATUS_LINE_MAX = 79;
/** The most `summary.md` may hold after its first line before the runner leaves the summary out. */
export const SUMMARY_REST_MAX = 600;

/** The dot and phrase for a move (ADR 0019). */
export function statusPhrase(move: Role, needs?: "answer" | "help"): string {
  if (move === "ready_to_build") return "🟢 Moving to build";
  if (move === "duplicate") return "🟢 Marked duplicate";
  if (move === "paused") return needs === "help" ? "🟡 Needs your help" : "🟡 Needs your answer";
  throw new Error(`no status phrase for a move to ${move}`);
}

/** "Flight Deck <version> · <stage> · session <session-id>" (ADRs 0019 and 0020). */
export function sessionFooter(version: string, stage: string, session: string): string {
  return `Flight Deck ${version} · ${stage} · session ${session}`;
}

/** "Flight Deck <version> · <stage> · follow-up", the footer of a follow-up issue's description (ADR 0019). */
export function followUpFooter(version: string, stage: string): string {
  return `Flight Deck ${version} · ${stage} · follow-up`;
}

function length(text: string): number {
  return [...text].length;
}

/**
 * The status line and the sentences under it. When `summary.md` is missing, its first line pushes the status
 * line past 79 characters, or the rest runs past 600, the status line comes from the move alone and the
 * summary is left out (ADR 0019).
 */
export function opening(phrase: string, summary: string | null): { statusLine: string; rest: string | null } {
  const [first = "", ...others] = (summary ?? "").trim().split("\n");
  const gist = first.trim();
  const rest = others.join("\n").trim();
  const statusLine = `${phrase}: ${gist}`;
  if (gist === "" || length(statusLine) > STATUS_LINE_MAX || length(rest) > SUMMARY_REST_MAX) {
    return { statusLine: phrase, rest: null };
  }
  return { statusLine, rest: rest === "" ? null : rest };
}

/** An answer as the comment lists it: its word, what it does, and the team's name for its status. */
export interface AnswerLine {
  word: string;
  does: string;
  status: string;
}

/**
 * The answer lines that end a pause's sentences (ADR 0019): "Reply with one word:", one line per answer with
 * the word in bold, what it does, and the status it moves the issue to, then the line for any other reply.
 */
export function answerLines(answers: readonly AnswerLine[]): string {
  const lines = answers.map(({ word, does, status }) => `- **${word}**: ${sentence(does)} Moves the issue to ${status}.`);
  return ["Reply with one word:", lines.join("\n"), "Any other reply leaves the issue paused until you move it."].join("\n\n");
}

/** The text with a full stop at its end, unless it ends a sentence already. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export interface HandoffComment {
  phrase: string;
  summary: string | null;
  /** A pause's answers. A pause with none, and every other handoff, leaves the answer lines out. */
  answers?: readonly AnswerLine[];
  /** A line after the rest of `summary.md` that survives a fallback, such as a duplicate's link to its original. */
  line?: string;
  /** The handoff file as it stands, or `null` for a duplicate, whose footer then ends the comment. */
  handoff: string | null;
  footer: string;
}

export function handoffComment(input: HandoffComment): string {
  const { statusLine, rest } = opening(input.phrase, input.summary);
  const answers = input.answers === undefined || input.answers.length === 0 ? [] : [answerLines(input.answers)];
  const end = input.handoff === null ? input.footer : fold("Details", `${flattenFolds(input.handoff)}\n\n${input.footer}`);
  return [statusLine, ...(rest === null ? [] : [rest]), ...(input.line === undefined ? [] : [input.line]), ...answers, end].join("\n\n");
}

/** "Duplicate of [<title>](<url>)." for the issue a duplicate's `of` names (ADR 0019). */
export function duplicateLine(original: { title: string; url: string }): string {
  return `Duplicate of [${original.title}](${original.url}).`;
}

/** Markdown emphasis markers that sit outside a word, so `snake_case` keeps its underscore. */
const EMPHASIS = /(?<![\p{L}\p{N}])[*_~]+|[*_~]+(?![\p{L}\p{N}])/gu;

/** The text with its Markdown emphasis markers removed. */
export function stripEmphasis(text: string): string {
  return text.replace(EMPHASIS, "");
}

const FOOTER = /^Flight Deck \S+ · /;
const FOLD_LINE = /^(?:\+\+\+|>>>)(?:[ \t].*)?$/;

/**
 * Whether text carries a Flight Deck footer (ADR 0019): a line matching `^Flight Deck \S+ · ` once Markdown
 * emphasis is stripped, as its last non-empty line, or as the last non-empty line inside its last fold. Plan
 * and the answer check both use this test.
 */
export function hasFooter(text: string): boolean {
  const lines = text.split("\n").map((line) => line.trim());
  const isFooter = (line: string | undefined) => line !== undefined && FOOTER.test(stripEmphasis(line));
  const nonEmpty = lines.filter((line) => line !== "");
  if (isFooter(nonEmpty.at(-1))) return true;
  // The last fold: the last closing line, and the opening line before it.
  const close = lines.findLastIndex((line) => FOLD_LINE.test(line) && line.replace(/^(?:\+\+\+|>>>)/, "").trim() === "");
  if (close <= 0) return false;
  const open = lines.findLastIndex((line, index) => index < close && FOLD_LINE.test(line));
  if (open < 0) return false;
  return isFooter(lines.slice(open + 1, close).filter((line) => line !== "").at(-1));
}
