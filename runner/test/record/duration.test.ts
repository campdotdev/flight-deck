import { expect, test } from "bun:test";
import { durationMs } from "../../src/record/index.ts";

test.each([
  ["30m", 1_800_000],
  ["1h30m", 5_400_000],
  ["180s", 180_000],
  ["2h", 7_200_000],
  ["1h1m1s", 3_661_000],
])("%s is %d ms", (duration, ms) => {
  expect(durationMs(duration)).toBe(ms);
});
