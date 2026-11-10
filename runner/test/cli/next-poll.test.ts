// The runner reads `config.toml` and `credentials.env` at every poll, so `login linear`, a rotated secret, and an
// edited cap take effect at the next poll with no restart (spec 1, "`config.toml` and `credentials.env`").
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Folders } from "../../src/folders/index.ts";
import { linearApps, readCredentials, writeCredentials } from "../../src/install/index.ts";
import { LinearTracker } from "../../src/tracker/index.ts";
import { World } from "../scenario/world.ts";
import { FakeLinear } from "../tracker/linear/fake-linear.ts";
import { repo, teamReply, STATUSES } from "../tracker/linear/linear-world.ts";
import { cli } from "./cli.ts";

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const each of cleanup) await each();
  cleanup = [];
});

async function world(): Promise<World> {
  const made = await World.create();
  cleanup.push(() => made.cleanup());
  return made;
}

test("login linear takes effect at the runner's next poll", async () => {
  const w = await world();
  await w.writeCredentials("");
  const issue = w.issue({ title: "Save button is blue" });
  w.send(issue);
  w.harness.script(issue.identifier, {});
  await w.tick();
  expect(w.harness.started).toEqual([]);

  const login = cli(w);
  login.answers.push("fd-client", "fd-secret", "reader-client", "reader-secret", "lin_api_setup");
  expect(await login.run("login", "linear", "campdotdev")).toBe(0);
  await w.tick();
  expect(w.harness.started.map((each) => each.session.issue)).toEqual([issue.identifier]);
});

test("an edited concurrency cap takes effect at the next poll", async () => {
  const w = await world();
  w.config.concurrency_cap = 1;
  await w.writeConfig();
  const issues = [w.issue({ title: "One" }), w.issue({ title: "Two" })];
  for (const issue of issues) {
    w.send(issue);
    w.harness.script(issue.identifier, {});
  }
  await w.tick();
  expect(w.harness.started).toHaveLength(1);
  w.config.concurrency_cap = 2;
  await w.writeConfig();
  await w.tick();
  expect(w.harness.started).toHaveLength(2);
});

test("a secret rotated in credentials.env is the one the runner's next mint sends", async () => {
  const root = await mkdtemp(join(tmpdir(), "flight-deck-rotate-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const folders: Folders = { data: join(root, "data"), config: join(root, "config"), sessionRoot: join(root, "sessions"), home: root };
  const linear = FakeLinear.start();
  cleanup.push(async () => linear.stop());
  linear.apps.set("fd-client", "old-secret");
  linear.on("FlightDeckTeam", teamReply(Object.values(STATUSES)));
  await writeCredentials(folders, { LINEAR_APP_ID_CAMPDOTDEV: "fd-client", LINEAR_APP_SECRET_CAMPDOTDEV: "old-secret" });
  // The runner's adapter, as `PRODUCTION_RUNNER` builds it, with Linear's origin pointed at the fake.
  const tracker = new LinearTracker({ identity: { kind: "flight_deck" }, apps: async (ws) => linearApps(await readCredentials(folders), ws), api: linear.url });
  expect(await tracker.checkTeam(repo)).toEqual({ ok: true });

  // The maintainer rotates the secret in Linear, which ends the old token, and writes the new one.
  linear.apps.set("fd-client", "new-secret");
  linear.accepted.clear();
  await writeCredentials(folders, { LINEAR_APP_SECRET_CAMPDOTDEV: "new-secret" });
  expect(await tracker.checkTeam(repo)).toEqual({ ok: true });
  expect(linear.mints.map((form) => form.client_secret)).toEqual(["old-secret", "new-secret"]);
});
