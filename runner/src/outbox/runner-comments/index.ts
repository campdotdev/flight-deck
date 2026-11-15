// The runner's own comments: the frame, the writes, and one file per case. Import a case from its own file,
// such as `./failed-twice.ts`, so a new case is a new file and touches no shared line.
export { runnerComment, runnerFooter, type FrameOptions, type RunnerComment, type RunnerFacts, type RunnerText } from "./frame.ts";
export { RunnerComments, type RunnerCommentsOptions, type RunnerTarget, type RunnerWriteResult } from "./writes.ts";
