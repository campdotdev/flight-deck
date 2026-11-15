// `no_init`: the session never sent `init`. The runner pauses the issue without using the retry, flags the
// maintainer, and offers `retry` (spec 1, "Exits", ADR 0007).
import { noInit as noInitText } from "../../outbox/runner-comments/no-init.ts";
import type { ExitHandler } from "./context.ts";

export const noInit: ExitHandler = (context) => context.pause(noInitText());
