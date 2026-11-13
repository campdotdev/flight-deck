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

export interface HandoffComment {
  phrase: string;
  summary: string | null;
  /** The handoff file as it stands. */
  handoff: string;
  footer: string;
}

export function handoffComment(input: HandoffComment): string {
  const { statusLine, rest } = opening(input.phrase, input.summary);
  const details = fold("Details", `${flattenFolds(input.handoff)}\n\n${input.footer}`);
  return [statusLine, ...(rest === null ? [] : [rest]), details].join("\n\n");
}
