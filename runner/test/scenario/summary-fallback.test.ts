// The summary fallback (spec 1, "The comment", ADR 0019): when `summary.md` is missing, its first line pushes the
// status line past 79 characters, or the rest runs past 600, the status line comes from the move alone, the
// summary is left out, and the fold still posts. Lengths count Unicode code points.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { outbox, World } from "./world.ts";

const BRIEF = "## Summary\n\nThe settings page's Save button turns red.";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

/** Plan hands off a brief whose outbox holds `summary` as `summary.md`, or none for `null`; returns the comment. */
async function handoff(summary: string | null): Promise<{ body: string; session: string }> {
  const issue = world.issue({ title: "Save button is blue" });
  world.send(issue);
  const files = outbox.brief({ summary: summary ?? "", brief: BRIEF });
  if (summary === null) delete files["summary.md"];
  world.harness.script(issue.identifier, { outbox: files, exit: { kind: "exited", code: 0 } });
  await world.tick();
  await world.tick();
  expect(world.tracker.stored(issue.id).status).toBe("Ready to build");
  const comment = world.tracker.writes.find((write) => write.kind === "comment");
  if (comment?.kind !== "comment") throw new Error("no comment");
  return { body: comment.body, session: world.harness.started[0]!.session.id };
}

/** The comment with the status line from the move alone: no summary, then the fold. */
function fallback(session: string): string {
  return ["🟢 Moving to build", "", "+++ Details", "", BRIEF, "", `Flight Deck ${world.version} · plan · session ${session}`, "", "+++"].join("\n");
}

/** "🟢 Moving to build: " is 19 code points, so a 60-code-point gist makes a 79-code-point status line. */
const GIST_MAX = 60;

describe("the status line comes from the move alone", () => {
  test("when summary.md is missing", async () => {
    const { body, session } = await handoff(null);
    expect(body).toBe(fallback(session));
  });

  test("when the first line pushes the status line past 79 code points", async () => {
    const { body, session } = await handoff(`${"a".repeat(GIST_MAX + 1)}\n\nThe button takes its color from a local style.`);
    expect(body).toBe(fallback(session));
  });

  test("when the rest runs past 600 code points", async () => {
    const { body, session } = await handoff(`Brief ready: the Save button turns red\n\n${"b".repeat(601)}`);
    expect(body).toBe(fallback(session));
  });
});

describe("the summary stays", () => {
  test("at a 79-code-point status line, counted in code points, and a 600-code-point rest", async () => {
    // The emoji is one code point and two UTF-16 units, so a count in UTF-16 units would reach 80.
    const gist = `🎨${"a".repeat(GIST_MAX - 1)}`;
    const rest = "c".repeat(600);
    const { body } = await handoff(`${gist}\n\n${rest}`);
    expect(body.split("\n").slice(0, 4)).toEqual([`🟢 Moving to build: ${gist}`, "", rest, ""]);
  });
});
