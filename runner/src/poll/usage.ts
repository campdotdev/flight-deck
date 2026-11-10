// The usage holds (spec 1, "Holds", ADRs 0002 and 0007). On a subscription the runner holds itself short of the
// plan limits, under `plan_limit`, read from the latest `rate_limit_event` or set by a session that exited
// `rate_limited`. On an API key it holds under `rate_limit` after a `rate_limited` exit, and under `api_cap` when
// a start would let spending pass a cap. `state/holds.json` keeps each hold with its end, and the latest event,
// so a hold survives a restart. `state/spend.json` keeps the day's and the month's spending.
import type { RateLimitEvent, RateLimitWindow } from "../harness/index.ts";
import type { Config } from "../install/index.ts";
import type { Holds, Spend, State, StatusUsage, StoredHold, UsageWindow } from "../state/index.ts";
import type { HoldSource } from "./holds.ts";

/** A `rate_limited` exit with no `resetsAt` holds this long. */
const NO_RESET_MS = 60_000;

/** Each plan window `[usage]` sets a threshold for: the event's window name, and its `config.toml` key. */
const WINDOWS = [
  { window: "five_hour", key: "five_hour" },
  { window: "seven_day", key: "weekly" },
] as const;

/** `plan_limit`, `rate_limit`, and `api_cap`: each usage hold in `state/holds.json` that hasn't reached its end. */
export const usageHolds: HoldSource = async ({ now, state }) =>
  (await state.holds()).holds.filter((hold) => holding(hold, now)).map(({ cause, since, until }) => ({ cause, scope: "runner", name: null, since, until }));

export class Usage {
  /** The last `rate_limit_event` a session reported since step 11 of the last poll. */
  private reported: RateLimitEvent | null = null;

  constructor(private readonly state: State) {}

  /** A running session reported a `rate_limit_event`. Step 11 of the next poll keeps it as the latest. */
  report(event: RateLimitEvent): void {
    this.reported = event;
  }

  /**
   * A session exited `rate_limited`: hold until `resetsAt`, or for 1 minute when the exit carries none, under
   * `plan_limit` on a subscription and `rate_limit` on an API key.
   */
  async rateLimited(now: Date, config: Config, resetsAt: string | null): Promise<void> {
    const until = resetsAt ?? new Date(now.getTime() + NO_RESET_MS).toISOString();
    const holds = await this.state.holds();
    await this.state.writeHolds(extend(holds, config.auth === "subscription" ? "plan_limit" : "rate_limit", now, until));
  }

  /**
   * Step 11 of the poll: keeps the latest `rate_limit_event`, drops each hold past its end, and on a
   * subscription holds under `plan_limit` until the reset of each window at or past its `[usage]` threshold.
   */
  async update(now: Date, config: Config): Promise<void> {
    const stored = await this.state.holds();
    let holds: Holds = { rate_limit_event: this.reported ?? stored.rate_limit_event, holds: stored.holds.filter((hold) => holding(hold, now)) };
    this.reported = null;
    if (config.auth === "subscription" && holds.rate_limit_event !== null) {
      const ends = WINDOWS.flatMap(({ window, key }) => {
        const read = windowAt(holds.rate_limit_event?.windows[window], now);
        return read !== null && read.utilization >= config.usage[key] ? [read.resets_at] : [];
      });
      for (const until of ends) holds = extend(holds, "plan_limit", now, until);
    }
    await this.state.writeHolds(holds);
  }

  /**
   * On an API key, a session ended: its `result` event's `total_cost_usd` counts toward the day and the
   * month, or its whole `session_budget_usd` when it ended with no `result` event, because its cost is unknown.
   */
  async spent(now: Date, config: Config, costUsd: number | undefined): Promise<void> {
    if (config.auth !== "api_key" || config.api === undefined) return;
    const usd = costUsd ?? config.api.session_budget_usd;
    const spend = spendAt(await this.state.spend(), now);
    await this.state.writeSpend({ ...spend, day_usd: spend.day_usd + usd, month_usd: spend.month_usd + usd });
  }

  /**
   * The cap test before each start (spec 1, "Holds"): on an API key, a start goes ahead only when each cap's
   * remaining amount covers the `session_budget_usd` of every running session plus this one, so spending never
   * passes a cap. A start that wouldn't fit holds under `api_cap` until the next local day, or the next local
   * month when the monthly cap is the one short. A start that fits ends the hold, so a raised cap or a session
   * that cost less than its budget frees the runner at once.
   */
  async fits(now: Date, config: Config, running: number): Promise<boolean> {
    let day = true;
    let month = true;
    if (config.auth === "api_key" && config.api !== undefined) {
      const { session_budget_usd, daily_cap_usd, monthly_cap_usd } = config.api;
      const spend = spendAt(await this.state.spend(), now);
      const needed = session_budget_usd * (running + 1);
      day = daily_cap_usd - spend.day_usd >= needed;
      month = monthly_cap_usd - spend.month_usd >= needed;
    }
    const holds = await this.state.holds();
    if (day && month) {
      if (holds.holds.some((hold) => hold.cause === "api_cap")) await this.state.writeHolds({ ...holds, holds: holds.holds.filter((hold) => hold.cause !== "api_cap") });
      return true;
    }
    const until = month ? nextDay(now) : nextMonth(now);
    const current = holds.holds.find((hold) => hold.cause === "api_cap" && holding(hold, now));
    const next: StoredHold = { cause: "api_cap", since: current?.since ?? now.toISOString(), until: until.toISOString() };
    await this.state.writeHolds({ ...holds, holds: [...holds.holds.filter((hold) => hold.cause !== "api_cap"), next] });
    return false;
  }

  /** `status.json`'s `usage`. */
  async status(now: Date, config: Config): Promise<StatusUsage> {
    if (config.auth === "api_key") {
      const { day_usd, month_usd } = spendAt(await this.state.spend(), now);
      return { auth: "api_key", day_usd, month_usd, daily_cap_usd: config.api?.daily_cap_usd ?? 0, monthly_cap_usd: config.api?.monthly_cap_usd ?? 0 };
    }
    const event = (await this.state.holds()).rate_limit_event;
    return { auth: "subscription", five_hour: windowAt(event?.windows.five_hour, now), weekly: windowAt(event?.windows.seven_day, now) };
  }
}

/**
 * A window as the runner counts it: `null` without a utilization and a reset time, and a utilization of 0
 * once its reset has passed, until a newer event arrives.
 */
function windowAt(window: RateLimitWindow | undefined, now: Date): UsageWindow | null {
  if (window === undefined || window.utilization === null || window.resetsAt === null) return null;
  const reset = now.getTime() >= new Date(window.resetsAt).getTime();
  return { utilization: reset ? 0 : window.utilization, resets_at: window.resetsAt };
}

/** The spending as of `now`: a new local day starts the day at 0, and a new local month the month too. */
function spendAt(spend: Spend | null, now: Date): Spend {
  const day = localDay(now);
  const month = day.slice(0, "YYYY-MM".length);
  return {
    day,
    day_usd: spend?.day === day ? spend.day_usd : 0,
    month,
    month_usd: spend?.month === month ? spend.month_usd : 0,
  };
}

/** `YYYY-MM-DD` in the Mac's time zone. */
function localDay(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The start of the next day in the Mac's time zone. */
function nextDay(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1);
}

/** The start of the next month in the Mac's time zone. */
function nextMonth(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth() + 1, 1);
}

function holding(hold: StoredHold, now: Date): boolean {
  return now.getTime() < new Date(hold.until).getTime();
}

/** Holds under `cause` until `until` at least. A hold still holding keeps its `since`, and never ends sooner. */
function extend(holds: Holds, cause: StoredHold["cause"], now: Date, until: string): Holds {
  const current = holds.holds.find((hold) => hold.cause === cause && holding(hold, now));
  const next: StoredHold =
    current === undefined ? { cause, since: now.toISOString(), until } : { ...current, until: later(current.until, until) };
  return { ...holds, holds: [...holds.holds.filter((hold) => hold.cause !== cause), next] };
}

function later(a: string, b: string): string {
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}
