// The answer check (spec 1's poll step 5, ADR 0019): which of the maintainer's replies answers a pause.
import { hasFooter, stripEmphasis } from "../outbox/index.ts";
import type { Answer, OpenPause, Reply } from "../state/index.ts";

/** A mention, as Linear's Markdown link or as a bare `@name`. */
const MENTION = /\[@[^\]]*\]\([^)]*\)|(?<!\S)@\S+/g;
/** An emoji, with its skin tone, joiner, and variation selector. */
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️⃣]/gu;

/**
 * A reply's first word: leading quote lines, mentions, emoji, and Markdown emphasis dropped, trailing
 * punctuation removed, lowercased. `null` when nothing is left.
 */
export function firstWord(body: string): string | null {
  const lines = body.split("\n");
  while (lines.length > 0 && /^\s*(?:>.*)?$/.test(lines[0] ?? "")) lines.shift();
  const text = stripEmphasis(lines.join("\n").replace(MENTION, " ").replace(EMOJI, " "));
  const word = text.trim().split(/\s+/)[0]?.replace(/\p{P}+$/u, "") ?? "";
  return word === "" ? null : word.toLowerCase();
}

/**
 * Whether a comment can answer a pause: the maintainer posted it after the pause comment, it carries no Flight
 * Deck footer, because a hand run posts the factory's comments under the maintainer's key, and it didn't come
 * through the GitHub sync, whoever Linear names as its author (ADR 0026).
 */
function canAnswer(reply: Reply, pause: OpenPause, maintainer: string): boolean {
  return reply.author === maintainer && !reply.synced && reply.created_at > pause.comment_at && !hasFooter(reply.body);
}

/** The answer the oldest reply that starts with one names, or `null`. */
export function answerOf(pause: OpenPause, maintainer: string): Answer | null {
  const replies = pause.replies.filter((reply) => canAnswer(reply, pause, maintainer));
  for (const reply of [...replies].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const word = firstWord(reply.body);
    const answer = pause.answers.find((each) => each.word === word);
    if (answer !== undefined) return answer;
  }
  return null;
}
