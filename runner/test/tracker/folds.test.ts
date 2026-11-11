import { describe, expect, test } from "bun:test";
import { flattenFolds, plusFolds, reportOf } from "../../src/tracker/folds.ts";

/** A reproduction with a Python prompt, which reads like a `>>>` fold line outside its fence. */
const REPRO = "Steps:\n\n```python\n>>> print(1 + 1)\n3\n>>>\n```\n\nIt prints 3.";

describe("fenced code", () => {
  test("plusFolds leaves fold-like lines inside a fence alone", () => {
    expect(plusFolds(`${REPRO}\n\n>>> Details\n\nBody\n\n>>>`)).toBe(`${REPRO}\n\n+++ Details\n\nBody\n\n+++`);
  });

  test("flattenFolds leaves fold-like lines inside a fence alone", () => {
    expect(flattenFolds(`+++ Details\n\n${REPRO}\n\n+++`)).toBe(`#### Details\n\n${REPRO}`);
  });

  test("a tilde fence, and a longer closing fence, end the code", () => {
    const text = "~~~~\n>>> a\n~~~\n>>> still code\n~~~~~\n>>> Details";
    expect(plusFolds(text)).toBe("~~~~\n>>> a\n~~~\n>>> still code\n~~~~~\n+++ Details");
  });

  test("a fence's +++ line doesn't close the report fold", () => {
    const description = `## Summary\n\nBrief.\n\n+++ Report\n\n${"```"}\n+++\n${"```"}\n\n+++`;
    expect(reportOf(description, true)).toBe("```\n+++\n```");
  });
});
