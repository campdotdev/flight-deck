// `status.json`, the one contract between the runner and the menu bar app (overview, spec 1's "`status.json`").
import type { SessionState, Stage } from "./state.ts";

export type HoldCause =
  | "maintainer"
  | "stop"
  | "plan_limit"
  | "api_cap"
  | "rate_limit"
  | "linear_token"
  | "claude_login"
  | "update"
  | "credentials"
  | "claude_code_version"
  | "github_token"
  | "linear_login"
  | "missing_status"
  | "team_unreadable"
  | "shared_team";

export interface StatusHold {
  cause: HoldCause;
  scope: "runner" | "workspace" | "repo";
  name: string | null;
  since: string;
  until: string | null;
}

export interface StatusSession {
  id: string;
  repo: string;
  issue: string;
  title: string;
  stage: Stage;
  state: SessionState;
  started_at: string | null;
  deadline: string | null;
}

export interface UsageWindow {
  utilization: number;
  resets_at: string;
}

export type StatusUsage =
  | { auth: "subscription"; five_hour: UsageWindow | null; weekly: UsageWindow | null }
  | { auth: "api_key"; day_usd: number; month_usd: number; daily_cap_usd: number; monthly_cap_usd: number };

export interface StatusRepo {
  name: string;
  record: "ok" | "waiting" | "invalid" | "newer";
  cache: "ok" | "refreshing" | "missing" | "failed";
  waiting_for_specs: { issue: string; title: string }[];
  /** A blocker the Flight Deck app can't read has a `null` title and status. */
  waiting_for_blockers: { issue: string; title: string; blockers: { issue: string; title: string | null; status: string | null }[] }[];
  waiting_for_port: { port: number; issues: string[] } | null;
}

export interface Status {
  version: string;
  heartbeat_at: string;
  polled_at: string;
  runner: { state: "working" | "held" | "stopped"; holds: StatusHold[] };
  sessions: StatusSession[];
  jobs: { kind: "cache_refresh"; repo: string; started_at: string }[];
  usage: StatusUsage;
  flags: { repo: string; issue: string; title: string; url: string; status_line: string; since: string }[];
  trouble: { cause: string; repos: string[]; issue_url: string | null; since: string }[];
  stale_takes: { repo: string; issue: string; title: string; status: string; since: string }[];
  repos: StatusRepo[];
}
