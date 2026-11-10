// The frame every comment the runner writes on its own shares (spec 1, "The runner's own comments", ADR 0019).
// Each case is one file beside this one that returns a `RunnerText`: its status line, its sentences, and its
// answers. The frame adds the answer lines, the `Details` fold with the runner's facts, and the runner footer.
// The text is fixed in code, with no model call.
import type { ExitKind } from "../../harness/index.ts";
import type { Role } from "../../record/index.ts";
import type { Answer, FlagCause } from "../../state/index.ts";
import { flattenFolds, fold } from "../../tracker/index.ts";
import { answerLines } from "../comment.ts";
import { SecretScanFailed, type SecretScan } from "../secret-scan.ts";

/** What one case says. A case file builds it from the case's own inputs. */
export interface RunnerText {
  /** The whole status line, dot and phrase included. A long status name may push it past 79 characters, and it stays whole. */
  statusLine: string;
  /** The sentences under the status line, or `null` for none beyond the answer lines. */
  sentences: string | null;
  /** The flag's cause, or `null` for the one comment that flags no one: the stop pause. */
  flag: FlagCause | null;
  /** A pause's answers, which end its sentences. `null` for a comment that doesn't pause the issue. */
  answers: readonly Answer[] | null;
  /** Text the case adds to the fold after the runner's facts, such as an invalid record's other errors. */
  details?: string;
}

/**
 * The runner's facts for the fold. A fact the case doesn't have is left out. Never transcript text, which
 * could carry a copied value.
 */
export interface RunnerFacts {
  exit?: ExitKind;
  session?: string;
  attempt?: number;
  transcript?: string;
  /** The last error message from the session's `result` event. */
  error?: string;
  /** `Workspace.prepare`'s message, when it failed. */
  prepare?: string;
}

/** A runner comment, ready for `RunnerComments.post`. */
export interface RunnerComment {
  body: string;
  statusLine: string;
  flag: FlagCause | null;
  answers: readonly Answer[] | null;
}

export interface FrameOptions {
  /** The running version. */
  version: string;
  /** The team's status names, for the answer lines. A comment with answers needs them. */
  statuses?: Record<Role, string>;
  /** The scan the error and prepare messages go through, with the repo whose copied files count. A comment whose facts hold either needs it. */
  secrets?: { scan: SecretScan; repo: string };
}

/** "Flight Deck <version> · runner" (ADR 0019). */
export function runnerFooter(version: string): string {
  return `Flight Deck ${version} · runner`;
}

/**
 * Builds the comment: the status line, the sentences, a pause's answer lines, then the fold and the footer.
 * The error and prepare messages go through the secret scan first, and a message the scan matches is left out.
 */
export async function runnerComment(text: RunnerText, facts: RunnerFacts, options: FrameOptions): Promise<RunnerComment> {
  const answers = text.answers ?? [];
  const statuses = options.statuses;
  if (answers.length > 0 && statuses === undefined) throw new Error("a runner comment with answers needs the team's status names");
  const lines = answers.length === 0 ? [] : [answerLines(answers.map(({ word, does, move }) => ({ word, does, status: statuses![move] })))];
  const inFold = [await factsText(facts, options), text.details ?? ""].filter((part) => part.trim() !== "").join("\n\n");
  const footer = runnerFooter(options.version);
  const details = fold("Details", inFold === "" ? footer : `${flattenFolds(inFold)}\n\n${footer}`);
  const body = [text.statusLine, ...(text.sentences === null ? [] : [text.sentences]), ...lines, details].join("\n\n");
  return { body, statusLine: text.statusLine, flag: text.flag, answers: text.answers };
}

/** The facts as a list, then each message in a code block, so its Markdown stays inert. */
async function factsText(facts: RunnerFacts, options: FrameOptions): Promise<string> {
  const list: string[] = [];
  if (facts.exit !== undefined) list.push(`- Exit: ${exitText(facts.exit)}`);
  if (facts.session !== undefined) list.push(`- Session: \`${facts.session}\``);
  if (facts.attempt !== undefined) list.push(`- Attempt: ${facts.attempt}`);
  if (facts.transcript !== undefined) list.push(`- Transcript: \`${facts.transcript}\``);
  const parts = list.length === 0 ? [] : [list.join("\n")];
  if (facts.error !== undefined) {
    parts.push((await secret(facts.error, options)) ? "Error message left out: it matched a secret rule." : `The session's last error:\n\n${codeBlock(facts.error)}`);
  }
  if (facts.prepare !== undefined) {
    parts.push((await secret(facts.prepare, options)) ? "Flight Deck's message left out: it matched a secret rule." : `Preparing the worktree failed with:\n\n${codeBlock(facts.prepare)}`);
  }
  return parts.join("\n\n");
}

/** Whether the secret scan matches the message. A scan that can't run counts as a match, so nothing unscanned is posted. */
async function secret(message: string, options: FrameOptions): Promise<boolean> {
  if (options.secrets === undefined) throw new Error("a runner comment with an error or prepare message needs the secret scan");
  try {
    return await options.secrets.scan.matches(options.secrets.repo, message);
  } catch (error) {
    if (error instanceof SecretScanFailed) return true;
    throw error;
  }
}

function exitText(exit: ExitKind): string {
  return exit.kind === "exited" ? `\`exited\` with code ${exit.code}` : `\`${exit.kind}\``;
}

/** A fenced block longer than any run of backticks in the text. */
export function codeBlock(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text.trim()}\n${fence}`;
}
