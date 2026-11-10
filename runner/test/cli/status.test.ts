// `flight-deck status` (spec 1, "`status.json` and `flight-deck status`", ADRs 0002, 0017, and 0021): it prints
// `status.json` as text, and says the runner isn't responding when the heartbeat is more than 3 minutes old.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Status } from "../../src/state/index.ts";
import { World } from "../scenario/world.ts";
import { cli } from "./cli.ts";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

/** A `status.json` with something in every section, as the runner writes it. */
const FULL: Status = {
  version: "0.1.0",
  heartbeat_at: "2026-11-10T09:05:00.000Z",
  polled_at: "2026-11-10T09:05:00.000Z",
  runner: {
    state: "held",
    holds: [
      { cause: "maintainer", scope: "runner", name: null, since: "2026-11-10T09:01:00.000Z", until: null },
      { cause: "plan_limit", scope: "runner", name: null, since: "2026-11-10T09:02:00.000Z", until: "2026-11-10T14:00:00.000Z" },
      { cause: "linear_token", scope: "workspace", name: "campdotdev", since: "2026-11-10T08:30:00.000Z", until: null },
    ],
  },
  sessions: [
    { id: "abc123", repo: "campdotdev/shaders", issue: "SHA-1", title: "Save button is blue", stage: "plan", state: "running", started_at: "2026-11-10T09:00:00.000Z", deadline: "2026-11-10T09:45:00.000Z" },
    { id: "def456", repo: "campdotdev/shaders", issue: "SHA-2", title: "Cancel button is green", stage: "plan", state: "retry_waiting", started_at: null, deadline: null },
  ],
  jobs: [{ kind: "cache_refresh", repo: "campdotdev/shaders", started_at: "2026-11-10T09:04:00.000Z" }],
  usage: { auth: "subscription", five_hour: { utilization: 0.42, resets_at: "2026-11-10T14:00:00.000Z" }, weekly: null },
  flags: [
    { repo: "campdotdev/shaders", issue: "SHA-3", title: "Which red", url: "https://linear.app/campdotdev/issue/SHA-3", status_line: "🟡 Needs your answer: which red?", since: "2026-11-10T08:50:00.000Z" },
  ],
  trouble: [{ cause: "linear_token", repos: ["campdotdev/shaders"], issue_url: null, since: "2026-11-10T08:30:00.000Z" }],
  stale_takes: [{ repo: "campdotdev/shaders", issue: "SHA-4", title: "Docs typo", status: "Planning", since: "2026-11-09T21:00:00.000Z" }],
  repos: [
    {
      name: "campdotdev/shaders",
      record: "ok",
      cache: "refreshing",
      waiting_for_specs: [{ issue: "SHA-5", title: "Theme spec" }],
      waiting_for_blockers: [
        {
          issue: "SHA-6",
          title: "Dark mode",
          blockers: [
            { issue: "SHA-7", title: "Color tokens", status: "Backlog" },
            { issue: "SHA-8", title: null, status: null },
          ],
        },
      ],
      waiting_for_port: { port: 3000, issues: ["SHA-9"] },
    },
  ],
};

async function writeStatus(status: Status, heartbeat = status.heartbeat_at): Promise<void> {
  await mkdir(join(world.folders.data, "state"), { recursive: true });
  await writeFile(join(world.folders.data, "state", "status.json"), JSON.stringify(status));
  await writeFile(join(world.folders.data, "state", "heartbeat"), JSON.stringify({ at: heartbeat }));
}

test("prints every section of status.json", async () => {
  await writeStatus(FULL);
  world.now = new Date("2026-11-10T09:06:00Z");
  const command = cli(world);
  expect(await command.run("status")).toBe(0);
  expect(command.out.join("\n")).toBe(
    [
      "Flight Deck 0.1.0 is held. It last polled at 2026-11-10 09:05 UTC, 1 minute ago.",
      "",
      "Holds:",
      "  maintainer, since 2026-11-10 09:01 UTC",
      "  plan_limit, since 2026-11-10 09:02 UTC, until 2026-11-10 14:00 UTC",
      "  linear_token on campdotdev, since 2026-11-10 08:30 UTC",
      "",
      "Sessions:",
      "  abc123 SHA-1 Save button is blue (campdotdev/shaders): plan, running, 6 minutes of its 45 minutes",
      "  def456 SHA-2 Cancel button is green (campdotdev/shaders): plan, retry_waiting",
      "",
      "Usage, on the subscription:",
      "  Five-hour window: 42% used, held at 80%, resets 2026-11-10 14:00 UTC",
      "  Weekly window: no reading yet, held at 70%",
      "",
      "Trouble:",
      "  linear_token in campdotdev/shaders, since 2026-11-10 08:30 UTC",
      "",
      "Stale takes:",
      "  SHA-4 Docs typo (campdotdev/shaders): in Planning since 2026-11-09 21:00 UTC",
      "",
      "Flags:",
      "  SHA-3 Which red (campdotdev/shaders): 🟡 Needs your answer: which red? Since 2026-11-10 08:50 UTC. https://linear.app/campdotdev/issue/SHA-3",
      "",
      "Repos:",
      "  campdotdev/shaders: record ok, cache refreshing",
      "    Waiting for spec support:",
      "      SHA-5 Theme spec",
      "    Waiting on blockers:",
      "      SHA-6 Dark mode",
      "        SHA-7 Color tokens: Backlog",
      "        SHA-8: unreadable",
      "    Waiting for port 3000:",
      "      SHA-9",
    ].join("\n"),
  );
});

test("prints none for each empty section, and an API key's spending against its caps", async () => {
  await writeStatus({
    ...FULL,
    runner: { state: "working", holds: [] },
    sessions: [],
    jobs: [],
    usage: { auth: "api_key", day_usd: 3.2, month_usd: 41, daily_cap_usd: 20, monthly_cap_usd: 200 },
    flags: [],
    trouble: [],
    stale_takes: [],
    repos: [{ name: "campdotdev/shaders", record: "waiting", cache: "missing", waiting_for_specs: [], waiting_for_blockers: [], waiting_for_port: null }],
  });
  world.now = new Date("2026-11-10T09:05:30Z");
  const command = cli(world);
  expect(await command.run("status")).toBe(0);
  expect(command.out.join("\n")).toBe(
    [
      "Flight Deck 0.1.0 is working. It last polled at 2026-11-10 09:05 UTC, 0 minutes ago.",
      "",
      "Holds: none",
      "",
      "Sessions: none",
      "",
      "Usage, on an API key:",
      "  Today: $3.20 of the $20.00 daily cap",
      "  This month: $41.00 of the $200.00 monthly cap",
      "",
      "Trouble: none",
      "",
      "Stale takes: none",
      "",
      "Flags: none",
      "",
      "Repos:",
      "  campdotdev/shaders: record waiting, cache missing",
      "    Waiting for spec support: none",
      "    Waiting on blockers: none",
    ].join("\n"),
  );
});

test("says the runner isn't responding when the heartbeat is more than 3 minutes old", async () => {
  await writeStatus(FULL);
  world.now = new Date("2026-11-10T09:08:00Z");
  const exactly = cli(world);
  await exactly.run("status");
  expect(exactly.out[1]).toBe("");

  world.now = new Date("2026-11-10T09:08:01Z");
  const late = cli(world);
  expect(await late.run("status")).toBe(0);
  expect(late.out.slice(0, 2)).toEqual([
    "Flight Deck 0.1.0 is held. It last polled at 2026-11-10 09:05 UTC, 3 minutes ago.",
    "The runner isn't responding: its last heartbeat was at 2026-11-10 09:05 UTC, 3 minutes ago.",
  ]);
});

test("prints the status the runner publishes", async () => {
  const issue = world.issue({ title: "Save button is blue" });
  world.send(issue);
  world.harness.script(issue.identifier, {});
  await world.tick();
  const command = cli(world);
  expect(await command.run("status")).toBe(0);
  const id = world.harness.started[0]!.session.id;
  expect(command.out).toContain(`  ${id} ${issue.identifier} Save button is blue (campdotdev/shaders): plan, running, 0 minutes of its 30 minutes`);
});

test("says so when the runner hasn't published status.json", async () => {
  const command = cli(world);
  expect(await command.run("status")).toBe(1);
  expect(command.err).toEqual(["The runner hasn't written status.json yet. It writes it at its first poll, after flight-deck install loads it."]);
});
