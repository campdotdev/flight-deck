// The Claude Code adapter's parser: what a session's `stream-json` lines and stderr say, and which exit wins when
// the session ends (spec 1, "Watchdogs and exits", ADRs 0002, 0005, and 0007). Its fields, units, and time format
// come from the fixtures in `test/harness/fixtures/`, which the Harness contract suite records.
import claudeCode from "../../../data/claude-code.toml";
import type { ExitKind, RateLimitEvent, RateLimitWindow } from "./types.ts";

/** `data/claude-code.toml`. */
export interface ClaudeCodeData {
  /** The oldest Claude Code this version runs (ADR 0015). */
  minVersion: string;
  /** A `result` with `is_error`, or an `assistant` message's error, that matches one ends with `login_expired`. */
  loginExpiredPatterns: RegExp[];
  /** A stderr line or a `system` event that matches one is Claude Code's warning that the login expires soon. */
  loginExpiringPatterns: RegExp[];
}

const data = claudeCode as { min_version: string; login_expired_patterns: string[]; login_expiring_patterns: string[] };

export const CLAUDE_CODE: ClaudeCodeData = {
  minVersion: data.min_version,
  loginExpiredPatterns: data.login_expired_patterns.map((pattern) => new RegExp(pattern)),
  loginExpiringPatterns: data.login_expiring_patterns.map((pattern) => new RegExp(pattern)),
};

/** What the adapter reports while the session runs. */
export type StreamEvent = { kind: "init" } | { kind: "rate_limit"; event: RateLimitEvent } | { kind: "login_expiring"; text: string };

/** What the stream said, for the exit. */
export interface StreamFacts {
  sawInit: boolean;
  loginExpired: boolean;
  /** Set by a `rate_limit` error or a rejected `rate_limit_event`. */
  rateLimited: { resetsAt: string | null } | null;
  /** The last `result` event. */
  result: { subtype: string; isError: boolean; costUsd: number | null } | null;
}

/** How the session ended, apart from what the stream said. */
export interface Ending {
  /** The runner asked the session to stop. */
  stopped: boolean;
  /** No `init` came within 2 minutes. */
  noInit: boolean;
  /** The stage's deadline passed. */
  timedOut: boolean;
  /** The exit code, or 128 plus the signal's number for a process a signal ended. */
  code: number;
}

/** One session's stream. Feed it each stdout line and stderr line in order. */
export class Stream {
  readonly facts: StreamFacts = { sawInit: false, loginExpired: false, rateLimited: null, result: null };
  private latestResetsAt: string | null = null;
  private warned = false;

  constructor(private readonly data: ClaudeCodeData) {}

  /** One `stream-json` line. Returns what to report. */
  line(text: string): StreamEvent[] {
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
      event = parsed as Record<string, unknown>;
    } catch {
      return [];
    }

    switch (event.type) {
      case "system":
        if (event.subtype === "init") {
          this.facts.sawInit = true;
          return [{ kind: "init" }];
        }
        return this.warning(text);
      case "rate_limit_event": {
        const rateLimit = rateLimitEvent(event.rate_limit_info);
        if (rateLimit === null) return [];
        if (rateLimit.resetsAt !== null) this.latestResetsAt = rateLimit.resetsAt;
        if (rateLimit.status === "rejected") this.facts.rateLimited = { resetsAt: rateLimit.resetsAt };
        return [{ kind: "rate_limit", event: rateLimit }];
      }
      case "assistant": {
        if (typeof event.error !== "string") return [];
        if (event.error === "rate_limit") this.facts.rateLimited ??= { resetsAt: this.latestResetsAt };
        else if (this.expired([event.error, ...messageText(event.message)])) this.facts.loginExpired = true;
        return [];
      }
      case "result": {
        const isError = event.is_error === true;
        this.facts.result = {
          subtype: typeof event.subtype === "string" ? event.subtype : "",
          isError,
          costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : null,
        };
        if (isError && this.expired([typeof event.result === "string" ? event.result : "", ...strings(event.errors)])) this.facts.loginExpired = true;
        return [];
      }
      default:
        return [];
    }
  }

  /** One stderr line. Claude Code may print the login-expiring warning there. */
  stderr(text: string): StreamEvent[] {
    return this.warning(text);
  }

  /** The login-expiring warning, reported once per session. */
  private warning(text: string): StreamEvent[] {
    if (this.warned || !this.data.loginExpiringPatterns.some((pattern) => pattern.test(text))) return [];
    this.warned = true;
    return [{ kind: "login_expiring", text }];
  }

  private expired(texts: string[]): boolean {
    return texts.some((text) => this.data.loginExpiredPatterns.some((pattern) => pattern.test(text)));
  }
}

/** The one exit. When more than one applies, the first in spec 1's order wins. */
export function exitOf(ending: Ending, facts: StreamFacts): ExitKind {
  if (ending.stopped) return { kind: "stopped" };
  if (ending.noInit) return { kind: "no_init" };
  if (ending.timedOut) return { kind: "timed_out" };
  if (facts.loginExpired) return { kind: "login_expired" };
  if (facts.rateLimited !== null) return { kind: "rate_limited", resetsAt: facts.rateLimited.resetsAt };
  return { kind: "exited", code: ending.code };
}

/** `rate_limit_info`, with each `resetsAt` from Unix seconds to an ISO time. */
function rateLimitEvent(info: unknown): RateLimitEvent | null {
  if (info === null || typeof info !== "object") return null;
  const record = info as Record<string, unknown>;
  const windows: Record<string, RateLimitWindow> = {};
  const unified = record.unifiedWindows;
  if (unified !== null && typeof unified === "object") {
    for (const [name, value] of Object.entries(unified as Record<string, unknown>)) {
      if (value === null || typeof value !== "object") continue;
      const window = value as Record<string, unknown>;
      windows[name] = {
        utilization: typeof window.utilization === "number" ? window.utilization : null,
        resetsAt: isoFromSeconds(window.resetsAt),
        status: typeof window.status === "string" ? window.status : null,
      };
    }
  }
  return {
    status: typeof record.status === "string" ? record.status : "",
    type: typeof record.rateLimitType === "string" ? record.rateLimitType : null,
    resetsAt: isoFromSeconds(record.resetsAt),
    windows,
  };
}

function isoFromSeconds(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
}

/** The text blocks of an `assistant` message. */
function messageText(message: unknown): string[] {
  if (message === null || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: unknown) => {
    const text = block !== null && typeof block === "object" ? (block as { text?: unknown }).text : undefined;
    return typeof text === "string" ? [text] : [];
  });
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];
}
