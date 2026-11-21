// The usage holds (spec 1, "Holds", ADRs 0002 and 0007). On a subscription the runner holds itself short of the
// plan limits, under `plan_limit`, read from the latest `rate_limit_event` or set by a session that exited
// `rate_limited`. On an API key it holds under `rate_limit` after a `rate_limited` exit, and under `api_cap` when
// a start would let spending pass a cap. `state/holds.json` keeps each hold with its end, and the latest event,
// so a hold survives a restart. `state/spend.json` keeps the day's and the month's spending.
import type { Exit, RateLimitEvent, RateLimitWindow } from "../harness/index.ts";
import type { Config } from "../install/index.ts";
import type { Holds, SessionEntry, Spend, State, StatusUsage, StoredHold, UsageWindow } from "../state/index.ts";
import type { HoldSource } from "./holds.ts";

/** A `rate_limited` exit with no `resetsAt` holds this long. */
const NO_RESET_MS = 60_000;

/** Each plan window `[usage]` sets a threshold for: the event's window name, and its `config.toml` key. */
const WINDOWS = [
  { window: "five_hour", key: "five_hour" },
  { window: "seven_day", key: "weekly" },
] as const;

/** The usage holds each way of paying puts on the runner, so a hold from the other way never holds it. */
const CAUSES: Record<Config["auth"], readonly StoredHold["cause"][]> = { subscription: ["plan_limit"], api_key: ["rate_limit", "api_cap"] };

/**
 * `plan_limit`, `rate_limit`, and `api_cap`: each usage hold in `state/holds.json` that hasn't reached its end,
 * for the way `config.toml` pays now. A `plan_limit` hold doesn't hold the runner once it pays with an API key.
 */
export const usageHolds: HoldSource = async ({ now, state, config }) =>
  (await state.holds()).holds
    .filter((hold) => CAUSES[config.auth].includes(hold.cause) && holding(hold, now))
    .map(({ cause, since, until }) => ({ cause, scope: "runner", name: null, since, until }));

/** How a session pays: on an API key when its launch recorded a budget, and on a subscription otherwise. */
export function launchAuth(entry: SessionEntry): Config["auth"] {
  return entry.budget_usd === undefined ? "subscription" : "api_key";
}

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
   * `plan_limit` when the session launched on a subscription and `rate_limit` when it launched on an API key. The
   * launch's `auth` decides, so a limit from one way of paying never holds starts that pay the other way.
   */
  async rateLimited(now: Date, auth: Config["auth"], resetsAt: string | null): Promise<void> {
    const until = resetsAt ?? new Date(now.getTime() + NO_RESET_MS).toISOString();
    const holds = await this.state.holds();
    await this.state.writeHolds(extend(holds, auth === "subscription" ? "plan_limit" : "rate_limit", now, until));
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
   * A session that launched on an API key ended: its `result` event's `total_cost_usd` counts toward the day and
   * the month, or its whole launch budget, `budgetUsd`, when it ended with no `result` event, because its cost is
   * unknown. The launch decides, not `config.toml` now, so a switch of `auth` while a session runs never drops
   * its cost or charges a subscription session. A session that launched on a subscription has no `budgetUsd`.
   */
  async spent(now: Date, exit: Exit, budgetUsd: number | undefined): Promise<void> {
    if (budgetUsd === undefined) return;
    const usd = exit.costUsd ?? budgetUsd;
    const spend = spendAt(await this.state.spend(), now);
    await this.state.writeSpend({ ...spend, day_usd: spend.day_usd + usd, month_usd: spend.month_usd + usd });
  }

  /**
   * The cap test before each start (spec 1, "Holds"): on an API key, a start goes ahead only when each cap's
   * remaining amount covers the budget of every running session plus this one's `session_budget_usd`, so
   * spending never passes a cap. `running` holds each running session's budget, the one its launch carried, or
   * 0 for a session that launched on a subscription. So lowering the budget never shrinks what a running session
   * may still spend. A start that wouldn't fit holds under `api_cap` until the
   * next local day, or the next local month when the monthly cap is the one short. A start that fits ends the
   * hold, so a raised cap or a session that cost less than its budget frees the runner at once.
   */
  async fits(now: Date, config: Config, running: readonly number[]): Promise<boolean> {
    let day = true;
    let month = true;
    if (config.auth === "api_key" && config.api !== undefined) {
      const { session_budget_usd, daily_cap_usd, monthly_cap_usd } = config.api;
      const spend = spendAt(await this.state.spend(), now);
      const needed = running.reduce((sum, budget) => sum + budget, session_budget_usd);
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
