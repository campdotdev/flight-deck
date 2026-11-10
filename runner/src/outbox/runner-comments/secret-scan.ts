// A secret-scan hit pauses the issue without posting any session text (spec 1, "The secret scan", ADRs 0007 and
// 0019). The comment names each file and the rule that matched, or the copied file's key whose value matched,
// never the value. Its `retry` moves the issue to Ready to plan.
import type { SecretHit } from "../secret-scan.ts";
import type { RunnerText } from "./frame.ts";

export function secretScanPause(hits: readonly SecretHit[]): RunnerText {
  const found = [...new Set(hits.map(hitSentence))].join(" ");
  return {
    statusLine: "🟡 Needs your help: plan's handoff held what looks like a secret",
    sentences: `Flight Deck found what looks like a secret in plan's handoff before posting it, so nothing from the session left the Mac. ${found} Reply with what plan should leave out, then reply retry.`,
    flag: "pause",
    answers: [{ word: "retry", does: "plan runs again and reads your replies", move: "ready_to_plan" }],
  };
}

function hitSentence(hit: SecretHit): string {
  if ("rule" in hit) return `\`${hit.file}\` matched the rule \`${hit.rule}\`.`;
  if ("key" in hit) return `\`${hit.file}\` holds the value of \`${hit.key}\` from \`${hit.copied}\`.`;
  return `\`${hit.file}\` holds line ${hit.line} of \`${hit.copied}\`.`;
}
