// Poll's step 2 keeps the last valid record in State, for the stale-take limits. Scenarios assert only through
// the seam, and no later step reads the record yet, so this test reads State itself.
import { afterEach, expect, test } from "bun:test";
import { State } from "../../src/state/index.ts";
import { SHADERS_RECORD, World } from "../scenario/world.ts";

let world: World;

afterEach(async () => {
  await world.cleanup();
});

test("State keeps the last valid record with the time of the latest poll that read it, also when the commit is unchanged", async () => {
  world = await World.create();
  const state = new State(world.folders);
  await world.tick();
  const first = await state.lastRecord(world.repo);
  expect(first?.commit).toBe(world.commit);
  expect(first?.read_at).toBe(world.now.toISOString());

  await world.tick();
  const again = world.now.toISOString();
  expect(await state.lastRecord(world.repo)).toEqual({ ...first!, read_at: again });

  await world.push({ ".flight-deck/record.toml": SHADERS_RECORD.replace('plan = "30m"', 'plan = "soon"') });
  await world.tick();
  expect(await state.lastRecord(world.repo)).toEqual({ ...first!, read_at: again });
});
