// The macOS notification the runner posts for trouble, through `osascript`, in case the Linear credential is
// what broke (spec 1, "Trouble issues", ADR 0011). It's titled "Flight Deck". The in-memory suites put a stub
// `osascript` first on the runner's `PATH`, so a scenario reads each notification without posting one.

/** The notification `flight-deck install` asks the runner for, after its trial run (spec 1, "Install"). */
export const TEST_NOTIFICATION = "Flight Deck can notify you.";

/** Posts one notification. It never throws: a notification that fails is only logged. */
export async function notify(text: string, options: { path: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const osascript = Bun.which("osascript", { PATH: options.path });
  if (osascript === null) return { ok: false, error: "no osascript on PATH" };
  try {
    // The text goes in as an argument, so no AppleScript quoting can break it.
    const proc = Bun.spawn(
      [osascript, "-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "Flight Deck", text],
      { env: { PATH: options.path }, stdout: "ignore", stderr: "pipe" },
    );
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return code === 0 ? { ok: true } : { ok: false, error: err.trim() || `exit ${code}` };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
