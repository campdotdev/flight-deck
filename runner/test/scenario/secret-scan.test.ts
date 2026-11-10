// The secret scan (spec 1, "The secret scan", ADRs 0007 and 0019): before any write, the Outbox runs the
// vendored Betterleaks over everything it would post, and matches the exact values of the repo's copied
// files. A hit pauses the issue with the runner's secret-scan text and posts no session text.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { StoredIssue } from "../../src/tracker/index.ts";
import { outbox, SHADERS_RECORD, World } from "./world.ts";

/** A GitHub token Betterleaks' default `github-pat` rule matches. Made up. */
const TOKEN = "ghp_4f8Xq2Lm9Rt7Vb3Nc6Hj1Kp5Wd0Zs8Ya2Ue4";

const BRIEF = "## Summary\n\nThe settings page's Save button turns red.";
const SUMMARY = "Brief ready: the settings Save button turns red\n\nThe button takes its color from a local style.";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

/** The writes after the issue's last move to Planning. */
function afterTake(issue: StoredIssue) {
  const writes = world.tracker.writes;
  const take = writes.findLastIndex((write) => write.kind === "move" && write.issue === issue.identifier && write.status === "Planning");
  return writes.slice(take + 1);
}

/** The secret-scan pause's comment, with `found` as the sentences that name each hit, and the last session's facts. */
function pauseBody(found: string): string {
  const session = world.harness.started.at(-1)!.session;
  return [
    "🟡 Needs your help: plan's handoff held what looks like a secret",
    "",
    `Flight Deck found what looks like a secret in plan's handoff before posting it, so nothing from the session left the Mac. ${found} Reply with what plan should leave out, then reply retry.`,
    "",
    "Reply with one word:",
    "",
    "- **retry**: plan runs again and reads your replies. Moves the issue to Ready to plan.",
    "",
    "Any other reply leaves the issue paused until you move it.",
    "",
    "+++ Details",
    "",
    "- Exit: `exited` with code 0",
    `- Session: \`${session.id}\``,
    "- Attempt: 1",
    `- Transcript: \`${session.transcript}\``,
    "",
    `Flight Deck ${world.version} · runner`,
    "",
    "+++",
  ].join("\n");
}

/** Sends the issue, scripts one session that leaves `files` in its outbox, and ticks until its exit is handled. */
async function runPlan(issue: StoredIssue, files: Record<string, string>): Promise<void> {
  world.send(issue);
  world.harness.script(issue.identifier, { outbox: files, exit: { kind: "exited", code: 0 } });
  await world.tick();
  await world.tick();
}

describe("a credential in the outbox", () => {
  test("pauses with the secret-scan text, names the file and the rule, and posts no session text", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await runPlan(issue, outbox.brief({ summary: `${SUMMARY}\n\nI used ${TOKEN} to read the repo.`, brief: BRIEF }));
    expect(afterTake(issue)).toEqual([
      { kind: "assign", issue: issue.identifier, user: world.maintainer.id },
      { kind: "comment", issue: issue.identifier, body: pauseBody("`summary.md` matched the rule `github-pat`.") },
      { kind: "move", issue: issue.identifier, status: "Paused" },
    ]);
    const posted = JSON.stringify(world.tracker.writes);
    for (const text of [TOKEN, "Brief ready", "Save button turns red"]) expect(posted).not.toContain(text);
    expect(world.tracker.stored(issue.id).description).toBe("");
  });
});

describe("the scan reads", () => {
  test("each follow-up issue, and files none on a hit", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await runPlan(issue, { ...outbox.brief({ summary: SUMMARY, brief: BRIEF }), "follow-ups/1.md": `# The Cancel button is blue too\n\nIt reads ${TOKEN}.\n` });
    expect(afterTake(issue)[1]).toEqual({ kind: "comment", issue: issue.identifier, body: pauseBody("`follow-ups/1.md` matched the rule `github-pat`.") });
    expect(world.tracker.writes.filter((write) => write.kind === "file")).toEqual([]);
  });

  test("each answer's does", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    const answers = [{ word: "go", does: `plan pushes with ${TOKEN}`, move: "ready_to_plan" as const }];
    await runPlan(issue, outbox.pause({ summary: "Needs a token: which one?", pause: "Which token?", answers, needs: "answer" }));
    expect(afterTake(issue)[1]).toEqual({ kind: "comment", issue: issue.identifier, body: pauseBody("`outcome.json` matched the rule `github-pat`.") });
  });
});

describe("the secret-scan pause's retry", () => {
  test("moves the issue to Ready to plan, and plan runs again", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await runPlan(issue, outbox.brief({ summary: `${SUMMARY}\n\n${TOKEN}`, brief: BRIEF }));
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
    world.reply(issue, "Leave the token out.");
    world.reply(issue, "retry");
    world.harness.script(issue.identifier, {});
    await world.tick();
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Planning");
    expect(world.harness.started).toHaveLength(2);
  });
});

describe("a copied file's exact value in the outbox", () => {
  /** A made-up test key that no Betterleaks rule matches, so only the exact-value match finds it. */
  const VALUE = "plum-harbor-41-velvet";

  beforeEach(async () => {
    await world.cleanup();
    world = await World.create({ record: SHADERS_RECORD.replace("copy_files = []", 'copy_files = [".env", "config/service.pem"]') });
    await world.copyFile(".env", `# Test credentials\nPORT=3000\nexport STRIPE_KEY="${VALUE}" # the test account\n`);
    await world.copyFile("config/service.pem", "-----BEGIN TEST KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END TEST KEY-----\n");
  });

  test("pauses and names the copied file's key, never the value", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await runPlan(issue, outbox.brief({ summary: SUMMARY, brief: `${BRIEF}\n\nThe test account's key is ${VALUE}.` }));
    const body = pauseBody("`brief.md` holds the value of `STRIPE_KEY` from `.env`.");
    expect(afterTake(issue)).toEqual([
      { kind: "assign", issue: issue.identifier, user: world.maintainer.id },
      { kind: "comment", issue: issue.identifier, body },
      { kind: "move", issue: issue.identifier, status: "Paused" },
    ]);
    expect(JSON.stringify(world.tracker.writes)).not.toContain(VALUE);
  });

  test("matches a file that isn't KEY=VALUE line by line", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await runPlan(issue, outbox.brief({ summary: SUMMARY, brief: `${BRIEF}\n\nThe service signs with b3BlbnNzaC1rZXktdjEAAAAA.` }));
    expect(afterTake(issue)[1]).toEqual({ kind: "comment", issue: issue.identifier, body: pauseBody("`brief.md` holds line 2 of `config/service.pem`.") });
  });

  test("PORT=3000 matches nothing", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await runPlan(issue, outbox.brief({ summary: SUMMARY, brief: `${BRIEF}\n\nThe app listens on PORT=3000.` }));
    expect(world.tracker.stored(issue.id).status).toBe("Ready to build");
  });
});
