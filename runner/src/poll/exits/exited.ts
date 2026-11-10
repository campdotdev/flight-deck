// An `exited` exit, whatever its code (spec 1, "Exits"). If the issue still sits in the stage's working
// status, the runner applies the outbox, and the Outbox's result decides. Otherwise the maintainer moved it:
// the outbox is discarded, with no retry and no pause.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sessionParts } from "../../folders/index.ts";
import type { ApplyResult } from "../../outbox/index.ts";
import { stillWorking } from "../moved-out.ts";
import { WORKING } from "../stages.ts";
import type { ExitContext, ExitHandler } from "./context.ts";
import { waitToApply } from "./unwritten.ts";

type ResultHandlers = { [K in ApplyResult["result"]]: (context: ExitContext, result: Extract<ApplyResult, { result: K }>) => Promise<void> };

/** What each `Outbox.apply` result does. A handed-off stage's retry count resets with its entry. */
const RESULTS: ResultHandlers = {
  applied: (context) => context.finish(),
  paused: (context) => context.finish(),
  failed: (context, result) => context.fail({ kind: "refused", rule: result.rule }),
  unwritten: (context, result) => waitToApply(context, result),
};

export const exited: ExitHandler = async (context) => {
  // A deleted, archived, or moved issue counts as moved out too.
  if ((await stillWorking(context.tracker, context.repo, context.entry)) === null) {
    await context.log(`left ${WORKING[context.entry.stage]}, outbox discarded`);
    return context.finish();
  }
  // A session that wrote no outcome.json exited without a handoff.
  if (!existsSync(join(sessionParts(context.sessionFolder).outbox, "outcome.json"))) {
    await context.log("exited without a handoff");
    return context.fail({ kind: "error" });
  }
  const result = await context.apply();
  await context.log(`outbox ${JSON.stringify(result)}`);
  // Each handler takes its own result, which TypeScript can't pair through the index.
  await (RESULTS[result.result] as (context: ExitContext, result: ApplyResult) => Promise<void>)(context, result);
};
