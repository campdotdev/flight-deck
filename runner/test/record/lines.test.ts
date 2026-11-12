import { describe, expect, test } from "bun:test";
import { keyLines } from "../../src/record/lines.ts";

describe("key lines after a multi-line string", () => {
  test.each([
    ["spanning lines", 'a = """\nx\ny"""\nb = 1\n', 4],
    ["with a line-ending backslash", 'a = """x \\\n  y"""\nb = 1\n', 3],
    ["with a line-ending backslash and CRLF", 'a = """x \\\r\n  y"""\r\nb = 1\r\n', 3],
    ["with an escaped backslash at a line's end", 'a = """x \\\\\ny"""\nb = 1\n', 3],
    ["holding an escaped fence", 'a = """x\\"""\ny"""\nb = 1\n', 3],
  ])("%s", (_, text, line) => {
    Bun.TOML.parse(text);
    expect(keyLines(text).lineOf(["b"])).toBe(line);
  });
});
