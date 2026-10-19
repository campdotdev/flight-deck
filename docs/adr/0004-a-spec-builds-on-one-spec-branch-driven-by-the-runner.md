# A spec builds on one spec branch, and the runner drives its issues

When the maintainer sends a spec, the runner cuts one spec branch from the default branch and starts each sub-issue once its blockers have landed there. Each sub-issue still passes through plan, build, and check in sessions of its own, under the concurrency cap. An issue lands when the runner fast-forwards the spec branch to the exact commit check passed, so every commit on the spec branch is one that check judged. Sub-issues open no PRs. When the last one lands, the spec branch becomes one PR, a spec check judges the whole change, and the maintainer merges once. An issue outside a spec keeps its own branch off the default branch and its own PR.

## Considered options

- **The board's model: one PR per issue, off the default branch.** A blocked issue would wait for its blockers to merge, so the maintainer's merges would set the pace. A chain of six issues would need six rounds of build and check with a merge between each, and the spec would reach the default branch one slice at a time.
- **`implement-spec` as one factory session.** One `claude -p` run would build the spec with parallel subagents on an integration branch. That puts taking issues, worktrees, the cap, and recovery back into prompt text, which ADR 0002 moved into the runner. The subagents would run outside the cap, a crash would restart the whole spec, and check would judge one large diff.
- **Stacked PRs.** Each issue's PR would target its blocker's branch. A fix low in the stack rebases every branch above it, and under ADR 0001 every new commit sends an issue back through check. The maintainer would still merge one PR per issue.
- **Landing with a merge commit when the merge is clean.** This saves a second check when two siblings run side by side. Two siblings that each pass but break each other would then show up only on the spec PR.

## Consequences

- When a sibling has landed first, the runner merges the new tip into the waiting issue's branch if git reports no conflict, and check judges the issue again. A conflict goes back to build. The runner's merge commit adds no lines of its own, so build is still the only stage that writes code.
- A PR into a spec branch would skip much of a repo's CI. On Shaders, `ci.yml` runs only for PRs into `main`, and CodeRabbit and ruleset-driven Copilot review only the default branch unless configured otherwise. A sub-issue's check runs the repo record's local commands instead. Full CI and every review bot run once, on the spec PR.
- Landed issues stay open until the spec PR merges, so Done still means the work is on the default branch.
- The spec check sends its findings to build, which works on the spec issue itself and pushes to the spec branch. The spec PR goes through ADR 0001's loop like any other PR.
- A spec with a sub-issue blocked from outside the spec doesn't start until that blocker is Done. The spec branch takes the default branch's new commits once, just before the spec PR opens.
