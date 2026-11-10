---
name: brief
description: The template for plan's brief, the description build works from.
disable-model-invocation: true
---

<!-- Fork of mattpocock/skills skills/engineering/triage/AGENT-BRIEF.md at 49dd158 (MIT, Matt Pocock).
     Changed: the brief replaces the issue's description instead of riding in a comment. No Category field and
     no pull request example. The bold labels become the seven ## headings that the runner finds the brief by.
     Key interfaces has fixed bullet shapes, each acceptance criterion names its proof, and Context holds
     pointers and ends with a ### Design subsection. -->

# Writing the brief

The brief is what build works from. The runner puts it in the issue's description and keeps the report in a fold beneath it. The report and its thread are context. The brief is the contract.

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

Every criterion is testable on its own, traces to the problem the report describes, and names its proof. A proof is one of these:

- **A record command category:** `types`, `lint`, `format`, `unit`, `integration`, or `e2e`, from the record's `[[commands]]`. Build writes the criterion's test where that command runs it.
- **running app:** build and check prove it in the app that the record's `[app]` starts.
- **type check only:** the change is proven when it compiles, such as a renamed export.

An extra, such as a `build` entry in the record's `[[extras]]`, is never a proof, because it has no category to hold a test. Check runs every local extra anyway. A criterion whose proof is a command with `where = "ci"` says "CI only", because build and check can't run it in a session.

Mark a criterion "regression guard" when it guards behavior that already works, so its test can pass before build's change.

- **Good:** "`<MeshGradient speed={0} cycleSpeed={0} />` renders the same frame at two times 1 s apart. Proof: `unit`."
- **Good:** "`<MeshGradient speed={1} />` still animates. Proof: `unit`. Regression guard."
- **Bad:** "MeshGradient works correctly at speed 0."

### Explicit scope boundaries

State what is out of scope, so build doesn't do more than the job needs or guess at adjacent work. What `ponytail` at `ultra` pushed back on goes here, unless it pauses the issue.

## Key interfaces

List each public contract the change breaks or adds, one bullet each, in one of these shapes:

- `` - `<contract>`: break (accepted), <what changes> ``
- `` - `<contract>`: added, <what it is> ``

You may also list a seam that isn't a public contract, because build writes its criterion tests there:

- `` - `<name>`: seam, <what changes> ``

Write the contract or seam name in code font, then a colon, then the second part. The runner reads only the bullets whose second part starts with "break", and refuses a handed-off brief unless each of them says "break (accepted)". A break the maintainer hasn't accepted never reaches a handed-off brief, because it pauses the issue. "break" without "(accepted)" appears only in the proposed brief of a pause.

When the change breaks or adds no contract and touches no seam worth naming, the section holds the one line "None."

## Template

Use these seven headings, in this order, with this exact text. The runner finds the brief and its Key interfaces by them.

```markdown
## Summary

One line: what has to happen.

## Current behavior

What happens now. For a bug, the broken behavior, and whether plan reproduced it.

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

- Reproduction: for a bug, the steps or the command, and what happened. Or "not reproduced", with what plan tried.
- Related issues: links, one line each on how they relate.
- GitHub issue: the link, for an issue synced from GitHub, and one line for each duplicate's GitHub issue. Build's PR closes each one.
- Where plan looked: paths and symbols, one line each.
- Slots: what each slot skill decided, such as "reproduce: reproduced with `pnpm test`" or "design: not checked".

### Design

- <state>: <frame link>
```

Leave out a Context line that has nothing to say. Out of scope with nothing to say holds the one line "None."

## The Design part

Context always ends with `### Design`. Later stages find the Design part by that heading. It holds one bullet per state the change creates or alters, shaped `- <state>: <frame link>`. After the maintainer answers `copy` to a pause about a missing frame, the state's bullet reads `- <state>: like <frame link>`, naming the nearest drawn frame.

Instead of the bullets, the part may hold one of these three lines:

- "design not checked", when the record's `design` slot is empty.
- "no design for <area>", when the change touches an existing area the design never drew.
- "no design needed", followed by the reason from the report's `## Design` section or the maintainer's reply.

## Bad brief

```markdown
**Summary:** Fix the triage bug

**What to do:**
The triage thing is broken. Look at the main file and fix it.
The function around line 150 has the issue.
```

This brief is bad for six reasons. It is vague. It points at a line number. It has none of the seven headings. It has no acceptance criteria or proofs. It has no scope boundary. It has no current or desired behavior.
