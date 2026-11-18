// A session's record at the commit it starts from is missing, invalid, or newer than the runner reads. Each
// pauses the issue at the take without using the stage's retry, and offers `retry` (spec 1's "Starts" and
// "The runner's own comments", ADRs 0003, 0015, 0017, and 0019).
import type { Answer } from "../../state/index.ts";
import type { RunnerText } from "./frame.ts";

const RETRY: Answer[] = [{ word: "retry", does: "plan reads the record again and runs", move: "ready_to_plan" }];

/** No `.flight-deck/record.toml` on the default branch. */
export function noRecord(branch: string): RunnerText {
  return {
    statusLine: "🟡 Needs your help: this repo has no Flight Deck record yet",
    sentences: `Plan reads the repo's record from \`.flight-deck/record.toml\` on \`${branch}\`, and \`${branch}\` has none. Run \`/flight-setup\` in the repo, then merge the record it writes to \`${branch}\`.`,
    flag: "pause",
    answers: RETRY,
  };
}

/** A record `readRecord` or the slot resolution refused. Quotes the first error, and puts the rest under Details. */
export function invalidRecord(branch: string, errors: readonly string[]): RunnerText {
  const [first = "", ...rest] = errors;
  const more = rest.length === 0 ? "" : rest.length === 1 ? " Its other error is under Details." : ` Its other ${rest.length} errors are under Details.`;
  const text: RunnerText = {
    statusLine: "🟡 Needs your help: this repo's Flight Deck record has an error",
    sentences: `Plan can't run, because the record at \`.flight-deck/record.toml\` on \`${branch}\` has an error:\n\n${codeBlock(first)}\n\nFix the record on \`${branch}\`.${more}`,
    flag: "pause",
    answers: RETRY,
  };
  if (rest.length > 0) text.details = `The record's other errors:\n\n${codeBlock(rest.join("\n"))}`;
  return text;
}

/** A record whose `schema` is newer than the one the runner reads. */
export function newerRecord(branch: string, schema: number, runnerSchema: number, version: string): RunnerText {
  return {
    statusLine: "🟡 Needs your help: this repo's record needs a newer Flight Deck",
    sentences: `The record on \`${branch}\` has schema ${schema}, and Flight Deck ${version} reads only schema ${runnerSchema}. Run \`flight-deck update\` on the Mac to install a version that reads it.`,
    flag: "pause",
    answers: RETRY,
  };
}

/** A fenced block longer than any run of backticks in the text, so an error's Markdown stays inert. */
function codeBlock(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text.trim()}\n${fence}`;
}
