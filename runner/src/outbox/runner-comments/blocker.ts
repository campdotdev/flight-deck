// A canceled blocker, or one that is a duplicate of nothing, pauses the issue from Ready to plan before any session
// (spec 1's "Starts" and "The runner's own comments", ADRs 0002 and 0004). It uses no retry.
import type { RunnerText } from "./frame.ts";

/** A blocker as the comment links it. */
export interface LinkedBlocker {
  title: string;
  url: string;
}

/** The pause's text. When the issue has both kinds, the canceled status line wins and the sentences list both. */
export function blockerPause(blockers: { canceled: readonly LinkedBlocker[]; nothing: readonly LinkedBlocker[] }): RunnerText {
  const { canceled, nothing } = blockers;
  const count = canceled.length + nothing.length;
  const sentences = [count === 1 ? "Plan can't start, because a blocker of this issue won't be done." : "Plan can't start, because blockers of this issue won't be done."];
  if (canceled.length > 0) sentences.push(`${links(canceled)} ${canceled.length === 1 ? "was" : "were"} canceled.`);
  if (nothing.length > 0) sentences.push(`${links(nothing)} ${nothing.length === 1 ? "is marked a duplicate" : "are marked duplicates"} of no issue.`);
  sentences.push(count === 1 ? "Remove the blocking relation, or reopen the blocker." : "Remove each blocking relation, or reopen each blocker.");
  return {
    statusLine: canceled.length > 0 ? "🟡 Needs your help: a blocker was canceled" : "🟡 Needs your help: a blocker is a duplicate of nothing",
    sentences: sentences.join(" "),
    flag: "pause",
    answers: [{ word: "retry", does: "Flight Deck tests the blockers again", move: "ready_to_plan" }],
  };
}

/** "[A](a)", "[A](a) and [B](b)", or "[A](a), [B](b), and [C](c)". */
function links(blockers: readonly LinkedBlocker[]): string {
  const each = blockers.map(({ title, url }) => `[${title}](${url})`);
  if (each.length <= 2) return each.join(" and ");
  return `${each.slice(0, -1).join(", ")}, and ${each.at(-1)}`;
}
