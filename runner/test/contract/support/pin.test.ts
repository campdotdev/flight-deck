// How a contract run writes what it measured into the files the version pins, and replaces a placeholder fixture.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "../../harness/fixtures.ts";
import { fits, loginExpiredPatterns, pinToml, recordFixture, socketNameBytes, tomlValue } from "./pin.ts";
import { contractParts } from "./gate.ts";

describe("pinToml", () => {
  const limits = `# Limits this version pins (spec 1, "Session IDs").

# The longest socket file name.
# PLACEHOLDER: the Harness contract suite (FLD-116) measures the real value.
socket_name_bytes = 40
`;

  test("replaces the key's value and the comment right above it, and keeps the rest", () => {
    const pinned = pinToml(limits, "socket_name_bytes", 31, ["The longest socket file name.", "Measured on 2026-11-10."]);
    expect(pinned).toBe(`# Limits this version pins (spec 1, "Session IDs").

# The longest socket file name.
# Measured on 2026-11-10.
socket_name_bytes = 31
`);
    expect(Bun.TOML.parse(pinned)).toEqual({ socket_name_bytes: 31 });
  });

  test("replaces a multi-line array", () => {
    const text = `min_version = "2.1.321"

# PLACEHOLDER until the suite records it.
login_expired_patterns = [
  "Login expired",
  "Please run /login",
]

# Kept.
login_expiring_patterns = [
  "login expires",
]
`;
    const pinned = pinToml(text, "login_expired_patterns", ["OAuth token has been revoked", "a\\.b"], ["Recorded."]);
    expect(Bun.TOML.parse(pinned)).toEqual({
      min_version: "2.1.321",
      login_expired_patterns: ["OAuth token has been revoked", "a\\.b"],
      login_expiring_patterns: ["login expires"],
    });
    expect(pinned).toContain("# Kept.\nlogin_expiring_patterns");
    expect(pinned).not.toContain("PLACEHOLDER");
  });

  test("appends a key the file doesn't hold yet", () => {
    expect(Bun.TOML.parse(pinToml("a = 1\n", "socket_name_bytes", 31, ["Measured."]))).toEqual({ a: 1, socket_name_bytes: 31 });
    expect(Bun.TOML.parse(pinToml("", "socket_name_bytes", 31, ["Measured."]))).toEqual({ socket_name_bytes: 31 });
  });

  test("writes a regular expression with a quote or a backslash so TOML reads it back unchanged", () => {
    for (const pattern of ["it's revoked", String.raw`\(401\)`, String.raw`say "hi"`, "tab\there"]) {
      expect(Bun.TOML.parse(`x = ${tomlValue(pattern)}`)).toEqual({ x: pattern });
    }
  });
});

describe("recordFixture", () => {
  let folder: string;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "flight-deck-pin-"));
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  test("writes the recording and removes its placeholder, so the tests read the recording", async () => {
    await writeFile(join(folder, "placeholder.result.max-budget.json"), '{"type":"result","placeholder":true}\n');
    expect(fixture("result.max-budget.json", folder)).toBe('{"type":"result","placeholder":true}');
    await recordFixture("result.max-budget.json", '{"type":"result","subtype":"error_max_budget_usd"}', folder);
    expect(existsSync(join(folder, "placeholder.result.max-budget.json"))).toBe(false);
    expect(await readFile(join(folder, "result.max-budget.json"), "utf8")).toBe('{"type":"result","subtype":"error_max_budget_usd"}\n');
    expect(fixture("result.max-budget.json", folder)).toBe('{"type":"result","subtype":"error_max_budget_usd"}');
  });
});

describe("loginExpiredPatterns", () => {
  test("takes the API error's message from a result, without its request ID", () => {
    const result = String.raw`Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has been revoked. Please obtain a new token or refresh your existing token."},"request_id":"req_011CUx"}`;
    expect(loginExpiredPatterns([result])).toEqual(["OAuth token has been revoked"]);
  });

  test("takes an assistant error's text as it is, with its characters escaped", () => {
    expect(loginExpiredPatterns(["Invalid API key · Please run /login"])).toEqual(["Invalid API key · Please run /login"]);
    expect(loginExpiredPatterns(["Login failed (401). Run /login"])).toEqual([String.raw`Login failed \(401\)`]);
  });

  test("drops repeats and empty texts", () => {
    expect(loginExpiredPatterns(["Login expired", "Login expired", "  "])).toEqual(["Login expired"]);
  });

  test("each pattern matches the text it came from", () => {
    const texts = ["Login failed (401). Run /login", String.raw`API Error: 401 {"error":{"message":"Token revoked [x]."}}`];
    const patterns = loginExpiredPatterns(texts).map((each) => new RegExp(each));
    for (const text of texts) expect(patterns.some((pattern) => pattern.test(text))).toBe(true);
  });
});

describe("socketNameBytes", () => {
  const tmp = "/Users/Shared/flight-deck/huntergarrett/sessions/a1b2c3/tmp";

  test("is the longest path after tmp/, counting a process ID at its widest", () => {
    expect(socketNameBytes(tmp, [`${tmp}/srt-mux-812-0.sock`, `${tmp}/c-1a2b/p.sock`])).toBe("srt-mux-81200-0.sock".length);
    expect(socketNameBytes(tmp, [`${tmp}/claude-sandbox-1a2b3c4d/http-proxy.sock`])).toBe("claude-sandbox-1a2b3c4d/http-proxy.sock".length);
  });

  test("counts bytes, not characters", () => {
    expect(socketNameBytes(tmp, [`${tmp}/é.sock`])).toBe(7);
  });

  test("ignores sockets outside the temp folder, and throws when none is inside it", () => {
    expect(socketNameBytes(tmp, [`${tmp}/a.sock`, "/tmp/a-much-longer-socket-name.sock"])).toBe(6);
    expect(() => socketNameBytes(tmp, ["/tmp/x.sock"])).toThrow("no socket");
  });

  test("fits when the temp folder, a slash, and the name come to 103 bytes at most", () => {
    // The maintainer's temp folder is 59 bytes (spec 1, "Session IDs").
    expect(Buffer.byteLength(tmp)).toBe(59);
    expect(fits(tmp, 43)).toBe(true);
    expect(fits(tmp, 44)).toBe(false);
  });
});

describe("FLIGHT_DECK_CONTRACT", () => {
  test("names the parts that run against real Linear and a real claude -p", () => {
    expect(contractParts(undefined)).toEqual(new Set());
    expect(contractParts("")).toEqual(new Set());
    expect(contractParts("0")).toEqual(new Set());
    expect(contractParts("1")).toEqual(new Set(["tracker", "harness", "lockdown", "instructions"]));
    expect(contractParts("all")).toEqual(new Set(["tracker", "harness", "lockdown", "instructions"]));
    expect(contractParts("tracker, lockdown")).toEqual(new Set(["tracker", "lockdown"]));
  });

  test("refuses a part it doesn't know, so a typo doesn't skip a suite quietly", () => {
    expect(() => contractParts("tracker,harnes")).toThrow("harnes");
  });
});
