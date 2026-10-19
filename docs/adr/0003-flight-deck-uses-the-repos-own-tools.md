# Flight Deck uses the repo's own tools and requires none of them

Flight Deck needs only its own platform: macOS, Claude Code, git, GitHub with `gh`, and Linear, plus Node and Chrome for a repo with a web app (ADR 0009). Every other tool a factory runs comes from the repo. Setup finds the tools the repo already uses and writes them into the repo record. Commands go into optional categories, such as unit tests or lint. Other checks go into a list of extras, and skills fill slots. Flight Deck never installs a tool into a repo or adds one to the repo's dependencies. When a repo lacks something, such as unit tests, setup offers an issue that describes the gap and leaves the choice of tool to plan.

## Considered options

- **The board's stack.** The board was drawn for one React component library, and its flows name Vitest, Storybook, Playwright, Fallow, React Doctor, Figma, and changesets. A fixed stack would let each flow run deeper checks written for those tools. Every repo outside that stack would have to adopt them or go without a factory.
- **A switch for each step Flight Deck knows.** A repo on a stack Flight Deck doesn't know would wait for a Flight Deck release.
- **Steps written only in the repo's `AGENTS.md`.** Nothing would prove a step ran, so check couldn't hold build to it.

## Consequences

- Each flow's review names the slots that flow offers. Setup writes Flight Deck's default skill for each slot into the repo record, and the maintainer adds, removes, or reorders skills there. If the record leaves a field out, the factory pauses the issue instead of assuming a default. A gap is written down as a gap.
- A Flight Deck dependency that acts on every session, such as a plugin's hooks, can't be forced into the maintainer's own Claude Code sessions. The runner decides what each factory session loads.
- Linear is the only tracker in v1. Flows reach it through named operations, and the runner's tracker code sits behind one interface, so another tracker can come later without new flows.
