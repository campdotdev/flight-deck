// Claude Code's login (spec 1, "Exits", "Trouble issues", ADR 0005). A session that exits `login_expired` opens
// `claude_login`, which holds every session until a trial run passes (`trial.ts` clears it). Claude Code's
// warning that the login expires soon opens `claude_login_soon`, which only files its trouble issue, and a later
// session whose stream no longer carries the warning clears it.
import type { Exit } from "../harness/index.ts";
import type { SessionEntry } from "../state/index.ts";
import type { Trouble } from "./trouble/trouble.ts";

export class LoginWatch {
  /** Each warning a session reported since the last poll. */
  private fresh: { session: string; warning: string }[] = [];
  /** Every session that reported the warning while this runner ran. */
  private readonly warned = new Set<string>();

  /** A running session reported Claude Code's warning. The next poll opens `claude_login_soon`. */
  expiring(session: string, warning: string): void {
    this.fresh.push({ session, warning });
    this.warned.add(session);
  }

  /** At each poll, before its exits: the latest warning since the last poll opens `claude_login_soon`. */
  poll(trouble: Trouble): void {
    const latest = this.fresh.at(-1);
    this.fresh = [];
    if (latest !== undefined) trouble.open("claude_login_soon", "runner", { scope: "runner", repos: [], facts: { session: latest.session, warning: latest.warning } });
  }

  /** At each exit: an expired login opens `claude_login`, and a session started after the warning without it clears `claude_login_soon`. */
  exited(now: Date, entry: SessionEntry, exit: Exit, trouble: Trouble): void {
    if (exit.kind === "login_expired") {
      trouble.open("claude_login", "runner", { scope: "runner", repos: [], facts: { session: entry.id, ...(exit.error === undefined ? {} : { error: exit.error }) } });
    }
    if (this.warned.delete(entry.id)) return;
    // A session that never sent `init`, or whose login had already expired, says nothing about the warning.
    if (exit.kind === "no_init" || exit.kind === "login_expired") return;
    const since = trouble.since("claude_login_soon", "runner", now);
    if (since !== null && entry.started_at !== null && entry.started_at >= since) trouble.clear("claude_login_soon", "runner");
  }
}
