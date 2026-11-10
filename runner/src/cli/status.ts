// `flight-deck status` (spec 1, "`status.json` and `flight-deck status`", ADRs 0002, 0017, and 0021): prints
// `status.json` as text. The runner computes every line it shows; this file only words them. When the heartbeat
// is more than 3 minutes old, it says the runner isn't responding.
import { paths } from "../folders/index.ts";
import { readConfig, type Config } from "../install/index.ts";
import { duration } from "../outbox/runner-comments/stale-take.ts";
import { readJson, type Status, type StatusHold, type StatusRepo } from "../state/index.ts";
import type { CommandContext } from "./context.ts";

/** A heartbeat older than this means the runner isn't responding (ADR 0021). */
const STALE_HEARTBEAT_MS = 3 * 60_000;

export async function statusCommand(context: CommandContext): Promise<number> {
  const status = await readJson<Status | null>(paths.status(context.folders), null);
  if (status === null) {
    context.err("The runner hasn't written status.json yet. It writes it at its first poll, after flight-deck install loads it.");
    return 1;
  }
  const heartbeat = (await readJson<{ at: string } | null>(paths.heartbeat(context.folders), null))?.at ?? status.heartbeat_at;
  // The thresholds live in config.toml, not in status.json.
  const config = await readConfig(context.folders).catch(() => null);
  for (const line of statusText(status, { now: context.clock(), heartbeat, config })) context.out(line);
  return 0;
}

function statusText(status: Status, { now, heartbeat, config }: { now: Date; heartbeat: string; config: Config | null }): string[] {
  const ago = (at: string) => duration(Math.max(0, now.getTime() - Date.parse(at)));
  const lines = [`Flight Deck ${status.version} is ${status.runner.state}. It last polled at ${time(status.polled_at)}, ${ago(status.polled_at)} ago.`];
  if (now.getTime() - Date.parse(heartbeat) > STALE_HEARTBEAT_MS) {
    lines.push(`The runner isn't responding: its last heartbeat was at ${time(heartbeat)}, ${ago(heartbeat)} ago.`);
  }
  section(lines, "Holds", status.runner.holds.map(holdLine));
  section(
    lines,
    "Sessions",
    status.sessions.map((session) => {
      const head = `${session.id} ${session.issue} ${session.title} (${session.repo}): ${session.stage}, ${session.state}`;
      if (session.started_at === null || session.deadline === null) return head;
      const limit = Date.parse(session.deadline) - Date.parse(session.started_at);
      return `${head}, ${ago(session.started_at)} of its ${duration(limit)}`;
    }),
  );
  lines.push("", ...usageLines(status.usage, config));
  section(lines, "Trouble", status.trouble.map((each) => `${each.cause}${each.repos.length > 0 ? ` in ${each.repos.join(", ")}` : ""}, since ${time(each.since)}${each.issue_url === null ? "" : `. ${each.issue_url}`}`));
  section(lines, "Stale takes", status.stale_takes.map((each) => `${each.issue} ${each.title} (${each.repo}): in ${each.status} since ${time(each.since)}`));
  section(lines, "Flags", status.flags.map((each) => `${each.issue} ${each.title} (${each.repo}): ${each.status_line} Since ${time(each.since)}. ${each.url}`));
  section(lines, "Repos", status.repos.flatMap(repoLines));
  return lines;
}

/** A blank line, then the heading and its indented lines, or the heading and "none". */
function section(lines: string[], heading: string, items: string[]): void {
  lines.push("");
  if (items.length === 0) lines.push(`${heading}: none`);
  else lines.push(`${heading}:`, ...items.map((item) => `  ${item}`));
}

function holdLine(hold: StatusHold): string {
  const on = hold.scope === "runner" || hold.name === null ? "" : ` on ${hold.name}`;
  return `${hold.cause}${on}, since ${time(hold.since)}${hold.until === null ? "" : `, until ${time(hold.until)}`}`;
}

function usageLines(usage: Status["usage"], config: Config | null): string[] {
  if (usage.auth === "api_key") {
    return ["Usage, on an API key:", `  Today: ${usd(usage.day_usd)} of the ${usd(usage.daily_cap_usd)} daily cap`, `  This month: ${usd(usage.month_usd)} of the ${usd(usage.monthly_cap_usd)} monthly cap`];
  }
  const window = (name: string, reading: (typeof usage)["five_hour"], threshold: number | undefined) => {
    const held = threshold === undefined ? "" : `, held at ${percent(threshold)}`;
    if (reading === null) return `  ${name}: no reading yet${held}`;
    return `  ${name}: ${percent(reading.utilization)} used${held}, resets ${time(reading.resets_at)}`;
  };
  return ["Usage, on the subscription:", window("Five-hour window", usage.five_hour, config?.usage.five_hour), window("Weekly window", usage.weekly, config?.usage.weekly)];
}

/** A repo's record and cache, then the issues waiting for spec support, on blockers, and for a port. */
function repoLines(repo: StatusRepo): string[] {
  const lines = [`${repo.name}: record ${repo.record}, cache ${repo.cache}`];
  const list = (heading: string, items: string[]) => {
    if (items.length === 0) lines.push(`  ${heading}: none`);
    else lines.push(`  ${heading}:`, ...items.map((item) => `    ${item}`));
  };
  list("Waiting for spec support", repo.waiting_for_specs.map((each) => `${each.issue} ${each.title}`));
  list(
    "Waiting on blockers",
    repo.waiting_for_blockers.flatMap((each) => [
      `${each.issue} ${each.title}`,
      ...each.blockers.map((blocker) => (blocker.title === null || blocker.status === null ? `  ${blocker.issue}: unreadable` : `  ${blocker.issue} ${blocker.title}: ${blocker.status}`)),
    ]),
  );
  if (repo.waiting_for_port !== null) list(`Waiting for port ${repo.waiting_for_port.port}`, repo.waiting_for_port.issues);
  return lines;
}

/** `2026-11-10 09:01 UTC`, as the trouble issues write a time. */
function time(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
