// The Claude Code adapter's parser, against stream lines recorded from real sessions. The fields, units, and time
// format come from the fixtures. A `placeholder.*` file stands in for each one the Harness contract suite (FLD-116)
// hasn't recorded yet, and `fixture` reads the recording once there is one: see `fixtures/README.md`. So the tests
// that read a replaceable fixture take their expected values from its raw fields, never from a placeholder's.
import { describe, expect, test } from "bun:test";
import { CLAUDE_CODE, exitOf, Stream, type Ending } from "../../src/harness/stream.ts";
import { fixture, fixtureEvent } from "./fixtures.ts";

/** A Unix time in seconds as the ISO time the parser reports. */
const iso = (seconds: unknown): string => new Date((seconds as number) * 1000).toISOString();

/** A recorded `rate_limit_event`'s `rate_limit_info`. */
function rateLimitInfo(name: string): Record<string, unknown> {
  return fixtureEvent(name).rate_limit_info as Record<string, unknown>;
}

/** The FLD-33 dry run's `rate_limit_event` on Claude Code 2.1.310, a known-good literal for the units. */
const ALLOWED_2_1_310 =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1792823400,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.04,"resetsAt":1792823400,"status":"allowed"},"seven_day":{"utilization":0.05,"resetsAt":1793358000,"status":"allowed"}}},"uuid":"c188c7dd-b7e7-48ab-b1b0-eb3bd4f425c1","session_id":"a0d51fc9-df00-4521-9a56-a38c6d08a216"}';

/** A session that ended on its own, with this exit code. */
const ended = (code: number): Ending => ({ stopped: false, noInit: false, timedOut: false, code });

describe("each fixture becomes the right event", () => {
  test("init", () => {
    const stream = new Stream(CLAUDE_CODE);
    expect(stream.facts.sawInit).toBe(false);
    expect(stream.line(fixture("init.json"))).toEqual([{ kind: "init" }]);
    expect(stream.facts.sawInit).toBe(true);
  });

  test("a rate_limit_event, with resetsAt from Unix seconds and utilization as a fraction", () => {
    const stream = new Stream(CLAUDE_CODE);
    expect(stream.line(ALLOWED_2_1_310)).toEqual([
      {
        kind: "rate_limit",
        event: {
          status: "allowed",
          type: "five_hour",
          resetsAt: "2026-10-24T06:30:00.000Z",
          windows: {
            five_hour: { utilization: 0.04, resetsAt: "2026-10-24T06:30:00.000Z", status: "allowed" },
            seven_day: { utilization: 0.05, resetsAt: "2026-10-30T11:00:00.000Z", status: "allowed" },
          },
        },
      },
    ]);
    expect(exitOf(ended(0), stream.facts)).toEqual({ kind: "exited", code: 0 });
  });

  test("the recorded allowed rate_limit_event reads its status, window, and times", () => {
    const stream = new Stream(CLAUDE_CODE);
    const info = rateLimitInfo("rate-limit-event.allowed.json");
    const [event] = stream.line(fixture("rate-limit-event.allowed.json"));
    expect(event).toMatchObject({ kind: "rate_limit", event: { status: "allowed", type: info.rateLimitType, resetsAt: iso(info.resetsAt) } });
    const windows = info.unifiedWindows as Record<string, { utilization: number; resetsAt: number }>;
    for (const [name, window] of Object.entries(windows)) {
      expect(event).toMatchObject({ event: { windows: { [name]: { utilization: window.utilization, resetsAt: iso(window.resetsAt) } } } });
    }
    expect(exitOf(ended(0), stream.facts)).toEqual({ kind: "exited", code: 0 });
  });

  test("a rejected rate_limit_event is reported and ends the session rate_limited at its resetsAt", () => {
    const stream = new Stream(CLAUDE_CODE);
    const resetsAt = iso(rateLimitInfo("rate-limit-event.rejected.json").resetsAt);
    const [event] = stream.line(fixture("rate-limit-event.rejected.json"));
    expect(event).toMatchObject({ kind: "rate_limit", event: { status: "rejected", resetsAt } });
    expect(exitOf(ended(1), stream.facts)).toEqual({ kind: "rate_limited", resetsAt });
  });

  test("a rate_limit error takes resetsAt from the latest rate_limit_event", () => {
    const stream = new Stream(CLAUDE_CODE);
    stream.line(fixture("rate-limit-event.allowed.json"));
    expect(stream.line(fixture("assistant.rate-limit-error.json"))).toEqual([]);
    expect(exitOf(ended(1), stream.facts)).toEqual({ kind: "rate_limited", resetsAt: iso(rateLimitInfo("rate-limit-event.allowed.json").resetsAt) });
  });

  test("a rate_limit error with no rate_limit_event has no resetsAt", () => {
    const stream = new Stream(CLAUDE_CODE);
    stream.line(fixture("assistant.rate-limit-error.json"));
    expect(exitOf(ended(1), stream.facts)).toEqual({ kind: "rate_limited", resetsAt: null });
  });

  test("a successful result exits with its code", () => {
    const stream = new Stream(CLAUDE_CODE);
    stream.line(fixture("init.json"));
    expect(stream.line(fixture("result.success.json"))).toEqual([]);
    expect(stream.facts.result).toEqual({ subtype: "success", isError: false, costUsd: 2.0853960000000002 });
    expect(exitOf(ended(0), stream.facts)).toEqual({ kind: "exited", code: 0 });
  });

  test("a run that --max-budget-usd ended exits with an error and no other exit", () => {
    const stream = new Stream(CLAUDE_CODE);
    stream.line(fixture("init.json"));
    const raw = fixtureEvent("result.max-budget.json");
    stream.line(fixture("result.max-budget.json"));
    const errors = (raw.errors ?? []) as string[];
    expect(stream.facts.result).toEqual({
      subtype: raw.subtype as string,
      isError: true,
      costUsd: raw.total_cost_usd as number,
      error: errors.at(-1) ?? (raw.result as string),
    });
    expect(exitOf(ended(1), stream.facts)).toEqual({ kind: "exited", code: 1 });
  });

  test("a result that matches login_expired_patterns", () => {
    const stream = new Stream(CLAUDE_CODE);
    stream.line(fixture("init.json"));
    stream.line(fixture("result.login-expired.json"));
    expect(exitOf(ended(1), stream.facts)).toEqual({ kind: "login_expired" });
  });

  test("an assistant message's error that matches login_expired_patterns", () => {
    const stream = new Stream(CLAUDE_CODE);
    stream.line(fixture("init.json"));
    stream.line(fixture("assistant.login-expired.json"));
    expect(exitOf(ended(1), stream.facts)).toEqual({ kind: "login_expired" });
  });

  test("the session's own words never count as an expired login, only an error does", () => {
    const stream = new Stream(CLAUDE_CODE);
    const words = JSON.parse(fixture("assistant.login-expired.json")) as Record<string, unknown>;
    delete words.error;
    stream.line(JSON.stringify(words));
    const result = JSON.parse(fixture("result.login-expired.json")) as Record<string, unknown>;
    stream.line(JSON.stringify({ ...result, is_error: false }));
    expect(exitOf(ended(0), stream.facts)).toEqual({ kind: "exited", code: 0 });
  });

  test("the login-expiring warning becomes one login_expiring event", () => {
    const stream = new Stream(CLAUDE_CODE);
    const warning = fixture("stderr.login-expiring.txt");
    expect(stream.stderr(warning)).toEqual([{ kind: "login_expiring", text: warning }]);
    expect(stream.stderr(warning)).toEqual([]);
  });

  test("the warning in a system event counts too", () => {
    const stream = new Stream(CLAUDE_CODE);
    const warning = fixture("stderr.login-expiring.txt");
    const line = JSON.stringify({ type: "system", subtype: "notification", text: warning });
    expect(stream.line(line)).toEqual([{ kind: "login_expiring", text: line }]);
  });

  test("a line that isn't JSON is ignored", () => {
    const stream = new Stream(CLAUDE_CODE);
    expect(stream.line("not json")).toEqual([]);
    expect(stream.line("")).toEqual([]);
  });
});

describe("exit precedence: stopped, no_init, timed_out, login_expired, rate_limited, exited", () => {
  const order = ["stopped", "no_init", "timed_out", "login_expired", "rate_limited", "exited"] as const;

  /** Facts with every reason from `from` on in the order. */
  function everythingFrom(from: number): { ending: Ending; stream: Stream } {
    const stream = new Stream(CLAUDE_CODE);
    const applies = new Set(order.slice(from));
    if (applies.has("login_expired")) stream.line(fixture("result.login-expired.json"));
    if (applies.has("rate_limited")) stream.line(fixture("rate-limit-event.rejected.json"));
    const ending: Ending = { stopped: applies.has("stopped"), noInit: applies.has("no_init"), timedOut: applies.has("timed_out"), code: 143 };
    return { ending, stream };
  }

  for (const [index, kind] of order.entries()) {
    test(`${kind} wins over everything after it`, () => {
      const { ending, stream } = everythingFrom(index);
      expect(exitOf(ending, stream.facts).kind).toBe(kind);
    });
  }

  test("exited carries the code", () => {
    expect(exitOf(ended(143), new Stream(CLAUDE_CODE).facts)).toEqual({ kind: "exited", code: 143 });
  });
});

describe("data/claude-code.toml", () => {
  test("holds the Mac's Claude Code version until the Shaders run pins min_version", () => {
    expect(CLAUDE_CODE.minVersion).toBe("2.1.321");
  });
});
