---
name: reproducing-bugs
description: Reproduce a reported bug with a failing test, then stop. Build's default reproduce slot.
disable-model-invocation: true
---

<!-- Fork of mattpocock/skills skills/engineering/diagnosing-bugs/SKILL.md at 49dd158 (MIT, Matt Pocock).
     Changed: keeps the redaction rule and Phases 1 and 2, and stops once the bug reproduces. Drops Phases 3 to 6,
     the HITL loop script, and the three things upstream asks a person for. Where upstream asks a person, it hands
     back what it tried instead. It ends with a failing test that build commits. The browser item names the browser
     MCP server, with curl when a session has none. -->

# Reproducing bugs

Build a loop that goes red on the reported bug, watch it go red, and shrink it into a failing test. Then stop. Finding the cause and fixing it belong to the `implement` slot.

Commit nothing. Build commits the failing test you hand back. Throwaway scripts stay uncommitted in the worktree.

Nobody is there to ask. Where upstream would ask a person, follow the rule in **When you can't build a loop**.

When you explore the codebase, read `GLOSSARY.md`, if it exists, for a clear model of the modules involved, and read the ADRs in the area you touch.

## Redact

This skill has you show commands, outputs, and captured artifacts. **Redact every secret first**: write `<REDACTED>` in its place. Build loops against environment variables, so the credential stays in the environment rather than in what you show. Captured artifacts carry auth headers, so quote only the lines that carry the signal.

## Phase 1: Build a feedback loop

If you have a **tight** pass or fail signal for the bug, one that goes red on _this_ bug, build will find the cause. Spend most of your effort here.

### Ways to construct one, in roughly this order

1. **Failing test** at whatever seam reaches the bug: unit, integration, or e2e.
2. **Curl or HTTP script** against the running app. Start it the way the repo's `AGENTS.md` says.
3. **CLI invocation** with a fixture input, diffing stdout against a known-good snapshot.
4. **The browser MCP server**, when the session has one, driving the running app and asserting on the DOM, computed styles, the console, or the network. Chromium can't start from sandboxed Bash, so when the sandbox is on, a Playwright or Puppeteer script you run yourself won't work. Without the browser server, drive the app with `curl`.
5. **Replay a captured trace.** Save a real payload or log to disk and replay it through the code path in isolation.
6. **Throwaway harness.** Start a minimal subset of the system that exercises the bug's code path with a single function call.
7. **Property or fuzz loop.** If the bug is "sometimes wrong output", run 1000 random inputs and look for the failure mode.
8. **Bisection harness.** If the bug appeared between two known states, automate "boot at state X, check, repeat" so you can `git bisect run` it.
9. **Differential loop.** Run the same input through two versions or two configs and diff the outputs.

### Tighten the loop

- Can I make it faster? Cache setup, skip unrelated init, and narrow the test scope.
- Can I make the signal sharper? Assert on the specific symptom, not "didn't crash".
- Can I make it more deterministic? Pin time, seed the random number generator, isolate the filesystem, and freeze the network.

### Non-deterministic bugs

The goal is a **higher reproduction rate**, not a clean repro. Loop the trigger, add stress, and narrow the timing windows.

### When you can't build a loop

Stop and say so in what you hand back. List what you tried and why each attempt failed, and what detail from the reporter would help. Don't guess at the cause without a loop. Build pauses the issue for the maintainer with that list.

A bug the session can't reach, such as a Safari-only bug, goes the same way. Say what blocked you.

### Completion criterion: a tight loop that goes red

Phase 1 is done when you can name **one command** that you have **already run at least once**, and that is:

- **Red-capable**: it drives the actual bug's code path and asserts the reporter's exact symptom.
- **Deterministic**: it gives the same verdict every run, or a pinned, high reproduction rate.
- **Fast**: it takes seconds, not minutes.
- **Agent-runnable**: it runs unattended.

## Phase 2: Reproduce and minimise

Run the loop. Watch it go red as the bug appears.

Confirm:

- The loop produces the failure mode the **reporter** described, not a different failure nearby.
- The failure reproduces across several runs.
- You have captured the exact symptom, such as an error message, a wrong output, or a slow timing, so build can verify its fix against it.

### Minimise

Shrink the repro to the **smallest scenario that still goes red**. Cut inputs, callers, config, data, and steps one at a time, and rerun the loop after each cut.

You are done when every remaining element is needed for the failure.

## Hand back

Build needs a failing test it can commit. When your loop is something other than a test, such as a curl script, turn the minimised scenario into a test where the repo's test command runs it, and watch that test go red too. When no test can hold the bug, say why in what you hand back.

Stop here. Hand back:

- The failing test, uncommitted in the worktree, and the command that runs it.
- That command's redacted output, and how often it went red.
- Anything you saw directly about where the bug lives, such as the function a stack trace names. Leave out guesses about the cause.

Leave the throwaway files uncommitted. Stop the app if you started it.
