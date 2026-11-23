---
name: brief
description: The template for a brief, the description of a feature issue that build works from.
disable-model-invocation: true
---

<!-- Fork of mattpocock/skills skills/engineering/triage/AGENT-BRIEF.md at 49dd158 (MIT, Matt Pocock).
     Changed: the maintainer writes the brief as the issue's description instead of in a comment. No Category
     field and no pull request example. The bold labels become seven ## headings that build finds the brief by.
     Key interfaces has fixed bullet shapes, each acceptance criterion names its proof, and Context holds
     pointers. -->

# Writing the brief

The brief is what build works from. The maintainer writes it as the issue's description, then adds `flight-feature`. Build works from its acceptance criteria, and check proves each one. The comment thread is context. The brief is the contract.

## Principles

### Durability over precision

The issue may wait for build while the codebase changes.

- **Do** describe interfaces, types, and behavioral contracts.
- **Do** name the types, function signatures, props, or config shapes build should look for or change.
- **Don't** put file paths or line numbers in the sections above Context. Context may name paths, because it holds pointers, not instructions.
- **Don't** assume the current implementation structure will stay the same.

### Behavioral, not procedural

Describe **what** the system should do, not **how** to build it. Build explores the code fresh and makes its own decisions. The exception is a fact you found that settles the how, such as a helper to reuse or the root cause. That fact goes in Context, as a pointer.

- **Good:** "`MeshGradient` casts an idle vote when `speed` and `cycleSpeed` are both 0."
- **Bad:** "Open `mesh-gradient.tsx` and add a branch on line 42."

### Complete acceptance criteria

Every criterion is testable on its own, traces to the problem the brief describes, and names its proof. A proof is one of these:

- **A test command:** one the repo's `AGENTS.md` names, such as `unit`, `integration`, or `e2e`. Build writes the criterion's test where that command runs it.
- **running app:** build and check prove it in the app, started the way the repo's `AGENTS.md` says.
- **type check only:** the change is proven when it compiles, such as a renamed export.

A criterion whose test runs only in CI says "CI only", because build and check can't run it in a session.

Mark a criterion "regression guard" when it guards behavior that already works, so its test can pass before build's change.

- **Good:** "`<MeshGradient speed={0} cycleSpeed={0} />` renders the same frame at two times 1 s apart. Proof: `unit`."
- **Good:** "`<MeshGradient speed={1} />` still animates. Proof: `unit`. Regression guard."
- **Bad:** "MeshGradient works correctly at speed 0."

### Explicit scope boundaries

State what is out of scope, so build doesn't do more than the job needs or guess at adjacent work.

## Key interfaces

List each public contract the change breaks or adds, one bullet each, in one of these shapes:

- `` - `<contract>`: break (accepted), <what changes> ``
- `` - `<contract>`: added, <what it is> ``

You may also list a seam that isn't a public contract, because build writes its criterion tests there:

- `` - `<name>`: seam, <what changes> ``

Write the contract or seam name in code font, then a colon, then the second part. A break listed here is one the maintainer accepts by writing the brief. Build makes no break that the brief doesn't list.

When the change breaks or adds no contract and touches no seam worth naming, the section holds the one line "None."

## Template

Use these seven headings, in this order, with this exact text. Build finds the acceptance criteria and Key interfaces by them.

```markdown
## Summary

One line: what has to happen.

## Current behavior

What happens now.

## Desired behavior

What happens once build is done, including edge cases and error conditions.

## Key interfaces

- `SkillConfig.schedule`: added, an optional field of type `CronExpression`.
- `castIdleVote()`: seam, casts a vote when both speeds are 0.

## Acceptance criteria

- [ ] Specific, testable criterion. Proof: `unit`.
- [ ] Specific, testable criterion. Proof: running app.
- [ ] Specific, testable criterion that already holds. Proof: `e2e`, CI only. Regression guard.

## Out of scope

- What build must not change or address here.

## Context

- Related issues: links, one line each on how they relate.
- GitHub issue: the link, for an issue synced from GitHub. Build's PR closes it.
- Where to look: paths and symbols, one line each.
```

Leave out a Context line that has nothing to say. Out of scope with nothing to say holds the one line "None."

## Bad brief

```markdown
**Summary:** Fix the triage bug

**What to do:**
The triage thing is broken. Look at the main file and fix it.
The function around line 150 has the issue.
```

This brief is bad for six reasons. It is vague. It points at a line number. It has none of the seven headings. It has no acceptance criteria or proofs. It has no scope boundary. It has no current or desired behavior.
