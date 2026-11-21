// `no_init`: the session never sent `init`. The runner pauses the issue without using the retry, flags the
// maintainer, and offers `retry` (spec 1, "Exits", ADR 0007).
import { noInit as noInitText } from "../../outbox/runner-comments/no-init.ts";
import { stopPause } from "../../outbox/runner-comments/stop.ts";
import type { ExitHandler } from "./context.ts";

// A session that exited before `flight-deck stop` reached it pauses as stopped, without a flag (ADR 0011).
export const noInit: ExitHandler = (context) => context.pause(context.entry.stop_cause === "stop" ? stopPause() : noInitText());
