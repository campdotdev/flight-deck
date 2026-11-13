// Plan pauses an issue, and the maintainer moves it on with a one-word reply (ADR 0019).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { outbox, World } from "./world.ts";
import type { StoredIssue } from "../../src/tracker/index.ts";

const PAUSE = "## Question\n\nThe report says red. The design system has two reds: `danger` and `brand`.";
const SUMMARY = "Which red should the Save button use?\n\nThe report asks for red, and the design system has two.";
const ANSWERS = [
  { word: "danger", does: "plan uses the danger red", move: "ready_to_plan" as const },
  { word: "brand", does: "plan uses the brand red.", move: "ready_to_plan" as const },
];

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

/** Sends an issue, and its plan session pauses it. Returns the session ID. */
async function paused(issue: StoredIssue, files = outbox.pause({ summary: SUMMARY, pause: PAUSE, answers: ANSWERS, needs: "answer" })): Promise<string> {
  world.send(issue);
  world.harness.script(issue.identifier, { outbox: files, exit: { kind: "exited", code: 0 } });
  await world.tick();
  await world.tick();
  return world.harness.started.at(-1)!.session.id;
}

/** The writes after the take. */
function afterTake(issue: StoredIssue) {
  const writes = world.tracker.writes;
  const take = writes.findIndex((write) => write.kind === "move" && write.issue === issue.identifier && write.status === "Planning");
  return writes.slice(take + 1);
}

describe("a pause", () => {
  test("assigns the maintainer before the comment, lists the answers, and moves the issue to Paused", async () => {
    const issue = world.issue({ title: "Save button is blue", description: "It should be red." });
    const session = await paused(issue);
    const comment = [
      "🟡 Needs your answer: Which red should the Save button use?",
      "",
      "The report asks for red, and the design system has two.",
      "",
      "Reply with one word:",
      "",
      "- **danger**: plan uses the danger red. Moves the issue to Ready to plan.",
      "- **brand**: plan uses the brand red. Moves the issue to Ready to plan.",
      "",
      "Any other reply leaves the issue paused until you move it.",
      "",
      "+++ Details",
      "",
      PAUSE,
      "",
      `Flight Deck ${world.version} · plan · session ${session}`,
      "",
      "+++",
    ].join("\n");
    expect(afterTake(issue)).toEqual([
      { kind: "assign", issue: issue.identifier, user: world.maintainer.id },
      { kind: "comment", issue: issue.identifier, body: comment },
      { kind: "move", issue: issue.identifier, status: "Paused" },
    ]);
    expect(world.tracker.stored(issue.id).assignee).toBe(world.maintainer.id);
  });
});

describe("a pause with no answers", () => {
  test("reads Needs your help and leaves out the answer lines", async () => {
    const issue = world.issue({ title: "Save button is blue", description: "It should be red." });
    const summary = "The Save button is already red\n\nThe settings page uses the shared red since last week. Close the issue if you agree.";
    const session = await paused(issue, outbox.pause({ summary, pause: PAUSE, answers: [], needs: "help" }));
    const comment = afterTake(issue).find((write) => write.kind === "comment");
    expect(comment).toEqual({
      kind: "comment",
      issue: issue.identifier,
      body: [
        "🟡 Needs your help: The Save button is already red",
        "",
        "The settings page uses the shared red since last week. Close the issue if you agree.",
        "",
        "+++ Details",
        "",
        PAUSE,
        "",
        `Flight Deck ${world.version} · plan · session ${session}`,
        "",
        "+++",
      ].join("\n"),
    });
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
  });
});

describe("a pause the Outbox refuses", () => {
  const outcome = (fields: Record<string, unknown>): Record<string, string> => ({
    ...outbox.pause({ summary: SUMMARY, pause: PAUSE, answers: ANSWERS, needs: "answer" }),
    "outcome.json": JSON.stringify({ version: "0.1.0", stage: "plan", move: "paused", answers: ANSWERS, needs: "answer", ...fields }),
  });
  const answer = (fields: Record<string, unknown>) => outcome({ answers: [{ ...ANSWERS[0], ...fields }] });
  test.each([
    ["no answers and needs answer", () => outcome({ answers: [] })],
    ["no needs", () => outcome({ needs: undefined })],
    ["a needs that isn't answer or help", () => outcome({ needs: "maybe" })],
    ["no answers list", () => outcome({ answers: undefined })],
    ["four answers", () => outcome({ answers: ["one", "two", "three", "four"].map((word) => ({ ...ANSWERS[0], word })) })],
    ["an answer word in capitals", () => answer({ word: "Danger" })],
    ["an answer of two words", () => answer({ word: "use danger" })],
    ["the same word twice", () => outcome({ answers: [ANSWERS[0], { ...ANSWERS[1], word: "danger" }] })],
    ["an answer that doesn't say what it does", () => answer({ does: " " })],
    ["an answer move Lifecycle doesn't allow from Paused", () => answer({ move: "building" })],
    ["a plan answer that names Ready to build", () => answer({ move: "ready_to_build" })],
    ["an answer with a key it doesn't take", () => answer({ status: "Ready to plan" })],
    ["no pause.md", () => {
      const files = outcome({});
      delete files["pause.md"];
      return files;
    }],
    ["a brief.md beside pause.md", () => ({ ...outcome({}), "brief.md": "## Summary" })],
  ])("with %s writes nothing to the issue", async (_, files) => {
    const issue = world.issue({ title: "Save button is blue", description: "It should be red." });
    await paused(issue, files());
    expect(afterTake(issue)).toEqual([]);
    expect(world.tracker.stored(issue.id).status).toBe("Planning");
  });

  test("a brief's outcome.json with answers is refused", async () => {
    const issue = world.issue({ title: "Save button is blue", description: "It should be red." });
    world.send(issue);
    const files = { "outcome.json": JSON.stringify({ version: "0.1.0", stage: "plan", move: "ready_to_build", answers: [], needs: "help" }), "summary.md": SUMMARY, "brief.md": "## Summary\n\nx" };
    world.harness.script(issue.identifier, { outbox: files, exit: { kind: "exited", code: 0 } });
    await world.tick();
    await world.tick();
    expect(afterTake(issue)).toEqual([]);
  });
});

describe("a one-word answer", () => {
  const RETRY = [{ word: "retry", does: "plan runs again", move: "ready_to_plan" as const }];
  const retryPause = () => outbox.pause({ summary: SUMMARY, pause: PAUSE, answers: RETRY, needs: "answer" });

  /** The writes since the pause landed. */
  function afterPause(issue: StoredIssue) {
    const writes = world.tracker.writes;
    const pause = writes.findIndex((write) => write.kind === "move" && write.issue === issue.identifier && write.status === "Paused");
    return writes.slice(pause + 1);
  }

  test("moves the issue to the answer's role, then clears the flag, and the next poll takes it", async () => {
    const issue = world.issue({ title: "Save button is blue", description: "It should be red." });
    await paused(issue);
    world.reply(issue, "brand");
    await world.tick();
    expect(afterPause(issue)).toEqual([
      { kind: "move", issue: issue.identifier, status: "Ready to plan" },
      { kind: "unassign", issue: issue.identifier },
      { kind: "unsubscribe", issue: issue.identifier, user: world.maintainer.id },
    ]);
    expect(world.tracker.stored(issue.id).assignee).toBeNull();
    world.harness.script(issue.identifier, {});
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Planning");
    expect(world.harness.started).toHaveLength(2);
  });

  test.each(["Retry.", "RETRY", "retry!", "Retry, but read the second screenshot first.", "**Retry**", "_retry_"])("%p matches retry", async (body) => {
    const issue = world.issue({ title: "Save button is blue" });
    await paused(issue, retryPause());
    world.reply(issue, body);
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
  });

  test.each([
    ["a leading quote", "> Which red should the Save button use?\n> The report asks for red.\n\nretry"],
    ["a mention", "@Hunter retry"],
    ["a mention as a link", "[@Hunter](https://linear.app/campdotdev/profiles/hunter) retry"],
    ["an emoji", "👍 retry"],
    ["an emoji with a skin tone", "👍🏽 Retry."],
  ])("drops %s before the first word", async (_, body) => {
    const issue = world.issue({ title: "Save button is blue" });
    await paused(issue, retryPause());
    world.reply(issue, body);
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
  });

  test.each(["Retrying", "retry-later", "Please retry", "Why retry?", ""])("%p doesn't match retry, and the issue stays paused and flagged", async (body) => {
    const issue = world.issue({ title: "Save button is blue" });
    await paused(issue, retryPause());
    world.reply(issue, body);
    await world.tick();
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
    expect(world.tracker.stored(issue.id).assignee).toBe(world.maintainer.id);
    expect(afterPause(issue)).toEqual([]);
  });

  test("an edit made after the first snapshot saw a reply changes nothing", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await paused(issue);
    const reply = world.reply(issue, "Which red is the brand one?");
    await world.tick();
    world.tracker.editComment(reply, "brand");
    await world.tick();
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
    expect(afterPause(issue)).toEqual([]);
  });

  test("the oldest reply that starts with an answer decides, and a later answer changes nothing", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await paused(issue);
    world.reply(issue, "Hmm, let me check the design file.");
    world.reply(issue, "danger, the one on the delete buttons");
    world.reply(issue, "brand");
    await world.tick();
    expect(afterPause(issue)[0]).toEqual({ kind: "move", issue: issue.identifier, status: "Ready to plan" });
    expect(afterPause(issue).filter((write) => write.kind === "move")).toHaveLength(1);
  });

  test("a reply in a thread counts", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await paused(issue);
    const pauseComment = world.tracker.stored(issue.id).comments.at(-1)!.id;
    world.reply(issue, "brand", { parent: pauseComment });
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
  });

  test.each([
    ["a comment posted before the pause", "before"],
    ["a comment that ends in a Flight Deck footer", "footer"],
    ["a comment whose fold ends in a Flight Deck footer", "fold footer"],
    ["a comment that came through the GitHub sync", "synced"],
    ["someone else's comment", "stranger"],
  ])("%s is never an answer", async (_, kind) => {
    const issue = world.issue({ title: "Save button is blue" });
    world.tracker.addUser({ id: "stranger", name: "Sam" });
    if (kind === "before") world.reply(issue, "brand");
    await paused(issue);
    if (kind === "footer") world.reply(issue, `brand\n\n*Flight Deck ${world.version} · plan · session abc123*`);
    if (kind === "fold footer") world.reply(issue, `brand\n\n+++ Details\n\nx\n\nFlight Deck ${world.version} · plan · session abc123\n\n+++`);
    if (kind === "synced") world.reply(issue, "brand", { synced: true });
    if (kind === "stranger") world.reply(issue, "brand", { author: "stranger" });
    await world.tick();
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
    expect(afterPause(issue)).toEqual([]);
  });

  test("a later comment can still answer after one that wasn't an answer, across polls", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await paused(issue);
    world.reply(issue, "Which one is on the delete buttons?");
    await world.tick();
    world.reply(issue, "Danger.");
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
  });

  test("an answer still works after a restart", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await paused(issue);
    world.restart();
    world.reply(issue, "brand");
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
  });
});

describe("a pause or answer whose Linear write fails", () => {
  /** Makes `tracker.move` to `role` fail `times` times, before the move lands or, with `after`, after it. */
  function failMoves(role: string, times: number, after = false) {
    const move = world.tracker.move.bind(world.tracker);
    let failures = times;
    world.tracker.move = async (ref, to) => {
      const fail = to === role && failures-- > 0;
      if (fail && !after) throw new Error("fetch failed");
      await move(ref, to);
      if (fail) throw new Error("socket hang up");
    };
  }

  test("a move to Paused whose response was lost still opens the pause, and an answer moves the issue on", async () => {
    const issue = world.issue({ title: "Save button is blue", description: "It should be red." });
    failMoves("paused", 1, true);
    await paused(issue);
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
    // The exit stays queued, and the retry records the pause though the issue left Planning.
    await world.tick();
    world.reply(issue, "brand");
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
    expect(world.tracker.writes.filter((write) => write.kind === "comment")).toHaveLength(1);
  });

  test("a reply posted before the move to Paused lands still answers, though the cursor passed it", async () => {
    const issue = world.issue({ title: "Save button is blue", description: "It should be red." });
    failMoves("paused", 2);
    await paused(issue);
    world.reply(issue, "brand");
    // A newer comment moves the repo's cursor past the answer.
    world.reply(issue, "The hover state should match.");
    // The move fails again, and the snapshot reads the reply while the issue sits in Planning.
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Planning");
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
  });

  test("an answer whose move fails keeps the reply as the first snapshot saw it", async () => {
    const issue = world.issue({ title: "Save button is blue", description: "It should be red." });
    await paused(issue);
    failMoves("ready_to_plan", 1);
    const reply = world.reply(issue, "brand");
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
    world.tracker.editComment(reply, "Which red is the brand one?");
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
  });
});
