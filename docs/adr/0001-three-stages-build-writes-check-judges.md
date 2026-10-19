# Three stages per issue: build writes, check judges

Every issue passes through three stages before the maintainer merges it: plan, build, and check. The board had five, with test and check as separate stages. A stage boundary stays only where a verdict has to be independent of the work it judges, or where the work waits on something outside the session: a queue, CI, review bots, or the maintainer. Test and check failed that rule. Both judge the same diff, and nothing outside the session waits between them, so proving each criterion became the first step of check. When a stage needs fresh eyes, it starts a subagent, which needs no handoff.

Build is the only stage that writes code. Check never pushes a commit. It sends numbered findings back to build, each with a failing case. Its verdict names the commit it judged, so any new commit sends the issue back through check. Every stage starts a fresh session and reads only what earlier stages wrote in Linear.

## Considered options

- **The board's five stages.** Every split costs a handoff, a status, a pick-up step, and a fresh session that re-reads the issue and the diff. The split between test and check bought no independence. The board's "Back to Agent QA" loop existed only because of that split.
- **Tests written in build, with check separate.** The builder would grade its own criteria.
- **Check pushes the tests it finds missing.** A push from check reruns CI, and check would then wait on a commit it wrote. A finding that carries the test costs one trip back to build instead.
