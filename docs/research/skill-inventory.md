# Skill inventory for the Flight Deck board

Research for [FLD-5](https://linear.app/campdotdev/issue/FLD-5/which-skills-on-the-board-exist-and-can-flight-deck-ship-them). Every source below was read on 2026-10-16.

Corrected on 2026-10-16: the maintainer pointed out that `technical-writing` and `unslop` come from the pstack plugin in `cursor/plugins`, under MIT. The first version of this note called them the maintainer's own. The copies in `campdotdev/agent-config` are modified forks of pstack's.

## Answer

The board has 19 skill cards. Add `unslop` and `watch-pr`, which the board names outside a skill card, plus `implement` and `implement-spec`, and the inventory covers 23 skills.

- 12 come from `mattpocock/skills`, which is MIT-licensed. All 12 are installed, and 4 of them carry local patches.
- 2 come from `DietrichGebert/ponytail`, also MIT: `ponytail` and `ponytail-review`. Neither is installed.
- 2 come from the pstack plugin in `cursor/plugins`, which is MIT: `technical-writing` and `unslop`. The installed copies are modified forks that live in the private `campdotdev/agent-config` repo.
- 1 is the maintainer's own: `watch-pr`. It lives in `campdotdev/agent-config`, which has no license.
- `resolving-merge-conflicts` was published in `mattpocock/skills` and removed on 2026-09-24. Its last version is still in that repo's git history under MIT.
- 5 have not been written for what the board asks: `flight-issue`, `design-check`, `standards-review`, `story`, and `changeset`. Other projects use some of these names for unrelated skills.

MIT lets a public repo bundle a skill, fork it, or depend on it. A bundled or forked copy has to keep the copyright and permission notice. A skill with no license can't be redistributed by anyone but its author. The maintainer can still publish `watch-pr` under a license of their choosing. Shipping the forked `technical-writing` and `unslop` means keeping pstack's MIT notice. `unslop`'s pattern list also follows `blader/humanizer`'s, so it may owe humanizer's MIT notice too. That lineage is unconfirmed.

## How the board labels skills

The board's legend and its "Start here" note give each kind of card its own color. Read from the board screenshots:

- A blue card is a **skill**, and its title starts with `/`.
- A gray card is a **step**, meaning instructions inside one skill. Step titles have no `/`.
- A purple card is a **flow**: `/flight-new`, `/flight-plan`, `/flight-build`, `/flight-test`, `/flight-check`, `/flight-launch`, `/flight-log`, and `/flight-debrief`.
- An orange card is a routine. The legend calls this kind an **orchestrator**. The routines are `triage routine`, `factory routine`, `launch routine`, `pr-merged routine`, `daily-brief routine`, `retro routine`, and `watch-pr routine`.
- A pink tag names the **MCP** a card uses: Linear, context7, or Figma.
- The legend defines a **router**, but no card on the board uses it.

These are the gray step cards. Flight Deck writes them inside its flow skills, so none of them needs an upstream: `pre-flight`, `pick up`, `read context`, `quick checks`, `map criteria`, `run levels`, `visual results`, `compare`, `evidence`, `hypotheses`, `classify`, `finish the PR`, `bot review`, `launch checks`, `publish`, `verify`, `announce`, `gather`, `sort`, `release section`, `measure`, `find`, and `open the PR`.

The `find` step in `/flight-debrief` reads "Matt's retro categories". Those come from `retro` in `mattpocock/skills`, which is installed and MIT-licensed.

## Inventory

"Patched" means `~/agent-config/patched/<name>/` holds a copy with local edits, and `link.sh` links it over the installed copy. `mattpocock/skills` paths are relative to `skills/` in that repo.

| Board name | Where on the board | Status | Source | License |
| --- | --- | --- | --- | --- |
| `/grill-with-docs` | Manual inputs, after `/flight-new` | Installed, patched | `mattpocock/skills`, `engineering/grill-with-docs`. The patch adds a closing decision walkthrough. | MIT, © 2026 Matt Pocock |
| `/to-spec` | Manual inputs | Installed | `mattpocock/skills`, `engineering/to-spec` | MIT, © 2026 Matt Pocock |
| `/to-tickets` | Manual inputs | Installed | `mattpocock/skills`, `engineering/to-tickets` | MIT, © 2026 Matt Pocock |
| `/flight-issue` | Manual inputs. A blue skill card, not a purple flow card. | Not written | Flight Deck's own | None yet |
| `/triage` | `/flight-plan`, in the pipeline and the decision tree | Installed | `mattpocock/skills`, `engineering/triage` | MIT, © 2026 Matt Pocock |
| `/diagnosing-bugs` | `/flight-plan`, `/flight-build`, and `/flight-test` | Installed | `mattpocock/skills`, `engineering/diagnosing-bugs` | MIT, © 2026 Matt Pocock |
| `/ponytail` | `/flight-plan` as `/ponytail ultra`, and `/flight-build` | Published upstream, not installed | `DietrichGebert/ponytail`, `skills/ponytail`. Commit `16352ac`, plugin version 5.3.2. | MIT, © 2026 DietrichGebert |
| `/ponytail-review` | `/flight-check` | Published upstream, not installed | `DietrichGebert/ponytail`, `skills/ponytail-review` | MIT. The repo LICENSE covers it. Its `SKILL.md` has no `license` field. |
| `/design-check` | `/flight-plan` and `/flight-build` | Not written | No upstream checks that Figma has a frame for every state. Unrelated skills share the name: `natrontech/wattroom` (AGPL-3.0), `Leo-Atienza/atlas-claude` (MIT), `stuffbucket/skills` (MIT), and `xoai/sage` (MIT). | None |
| `/tdd` | `/flight-build` and `/flight-test` | Installed | `mattpocock/skills`, `engineering/tdd` | MIT, © 2026 Matt Pocock |
| `/standards-review` | `/flight-build` and `/flight-check` | Not written | No common upstream. The closest match is the Standards axis of `mattpocock/skills` `code-review`. `galfrevn/apollo` ships `code-review` renamed as `standards-review`. `canonical/code-review-harness` and other repos use the name for their own skills. | None |
| `/story` | `/flight-build` | Not written | The closest match is Storybook's official `stories` skill. It sits on the `next` branch of `storybookjs/skills`, synced from Storybook 11.0.0-alpha.5. Storybook generates it from `code/core/src/cli/skills` in `storybookjs/storybook`, and it requires Storybook 11 or later. | `storybookjs/skills` has no LICENSE file. `storybookjs/storybook` is MIT. Which license covers the skill text is unconfirmed. |
| `/changeset` | `/flight-build` | Not written | The `changesets` GitHub org publishes no skill. skills.sh lists dozens of repo-local `changeset` skills, from `withastro/astro`, `biomejs/biome`, `udecode/plate`, and others. | None |
| `/resolving-merge-conflicts` | `/flight-build` | Published upstream, then removed | `mattpocock/skills`, `engineering/resolving-merge-conflicts`. Commit `daa01d8` removed it on 2026-09-24, and the last version is at `153fc1b`. | MIT, © 2026 Matt Pocock |
| `/code-review` | `/flight-check`, in the pipeline and the decision tree | Installed, patched | `mattpocock/skills`, `engineering/code-review`. The patch adds GitButler and Linear handling. | MIT, © 2026 Matt Pocock |
| `/codebase-design` | `/flight-check`, in the pipeline and the decision tree | Installed | `mattpocock/skills`, `engineering/codebase-design` | MIT, © 2026 Matt Pocock |
| `/technical-writing` | `/flight-launch` and `/flight-log`. A note on every decision tree also names it. | Installed, modified fork | `cursor/plugins`, `pstack/skills/technical-writing`. The installed copy is a modified fork in `campdotdev/agent-config`, `skills/technical-writing`, which is private. 56 lines differ from pstack. | MIT, © 2026 Lauren Tan, from pstack. The skill summarizes Diátaxis (CC BY-SA 4.0), Google's developer style guide (CC BY 4.0), ASD-STE100, and Kohl's *Global English Style Guide*. The last two are copyrighted publications. |
| `/wizard` | `/flight-launch` and the rollback outcome | Installed | `mattpocock/skills`, `engineering/wizard` | MIT, © 2026 Matt Pocock |
| `/writing-for-agents` | Feedback loop and `/flight-debrief` | Installed | `mattpocock/skills`, `productivity/writing-for-agents` | MIT, © 2026 Matt Pocock |
| `unslop` | No card. Notes on every decision tree name it, and so do the `/technical-writing` cards. | Installed, modified fork | `cursor/plugins`, `pstack/skills/unslop`. The installed copy is a modified fork in `campdotdev/agent-config`, `skills/unslop`, which is private. 50 lines differ from pstack, and the fork drops pstack's `disable-model-invocation: true`. | MIT, © 2026 Lauren Tan, from pstack. Patterns 1 to 12 and 15 to 25 follow `blader/humanizer`'s pattern list in the same order. humanizer is MIT, © 2025 Siqi Chen, and is based on Wikipedia's "Signs of AI writing" page, which is CC BY-SA 4.0. |
| `watch-pr` | `/flight-check`, as the orange `watch-pr routine` card and inside the gray `bot review` step | Installed, maintainer's own | `campdotdev/agent-config`, `skills/watch-pr`. It calls `resolve-pr-feedback` from the same repo. | No LICENSE |
| `implement` | Not on the board. The complex-issue path uses it today. | Installed, patched | `mattpocock/skills`, `engineering/implement` | MIT, © 2026 Matt Pocock |
| `implement-spec` | Not on the board. A standing decision on FLD-2 names it. | Installed, patched | `mattpocock/skills`, `engineering/implement-spec`. The patch keeps commits, merges, and pushes in worktrees inside a GitButler workspace. | MIT, © 2026 Matt Pocock |

## What each license lets a public repo do

| License | Bundle | Fork and modify | Depend on it |
| --- | --- | --- | --- |
| MIT: `mattpocock/skills`, `DietrichGebert/ponytail`, `cursor/plugins` (pstack), `blader/humanizer`, and `storybookjs/storybook` | Yes, if the copyright and permission notice ships with every copy or substantial portion | Yes, under the same condition | Yes |
| No license: `campdotdev/agent-config` and `storybookjs/skills` | Only the author can | Only the author can | Yes. Installing from the source repo copies nothing into Flight Deck. |
| CC BY-SA 4.0: Wikipedia and Diátaxis | Yes, with attribution, under CC BY-SA 4.0 | An adaptation must carry attribution and CC BY-SA 4.0 | Not applicable |

The MIT text in all five MIT repos is the standard one. Its only condition is: "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software."

Two questions here are legal, and this note doesn't settle them. One is whether `unslop` counts as a substantial portion of humanizer. The other is whether `technical-writing`'s summaries count as adaptations of their sources.

## What this means for Flight Deck

These are facts that limit the repo-record and packaging decisions. The decisions belong to the maintainer.

1. **One upstream supplies most of the skills, and it changes often.** 12 of the 23 skills come from `mattpocock/skills`. Version 1.3.0 removed `resolving-merge-conflicts` and renamed `CONTEXT.md` to `GLOSSARY.md` in every skill that reads it. In `~/.agents/.skill-lock.json`, 12 of the 26 installed `mattpocock/skills` skills have a folder hash that differs from upstream `HEAD` (`49dd158`, 2026-10-09). The drifted ones include `tdd`, `diagnosing-bugs`, `to-tickets`, `wizard`, `code-review`, and `implement`. A bundled copy falls behind, and a dependency can change between two factory runs.
2. **The four patches exist only in a private repo.** The `code-review`, `grill-with-docs`, `implement`, and `implement-spec` patches live in `campdotdev/agent-config`. A public Flight Deck can't install them from there.
3. **The maintainer's own skills have no license.** `watch-pr` and `resolve-pr-feedback`, which `watch-pr` calls, live in that private repo. Nobody else can redistribute them until the maintainer publishes them under a license. The forked `technical-writing` and `unslop` live there too, and shipping them means keeping pstack's MIT notice.
4. **Upstream behavior differs from what the board asks for.**
   - In `/flight-test`, the board says `/diagnosing-bugs` "never fixes". Upstream `diagnosing-bugs` ends with "Phase 5: Fix + regression test".
   - In `/flight-test`, the board says `/tdd` "Never touches app code". Upstream `tdd` runs red-green-refactor, which writes app code.
   - The board sends a merge conflict it can't resolve to a person. The last upstream `resolving-merge-conflicts` says "Always resolve; never `--abort`."
   - The board's two `ponytail` cards match the current upstream text. An older copy vendored at `40e50d9`, in `dmae97/omk`, scoped `ponytail-review` to over-engineering only. Without a pinned commit, the behavior shifts.
5. **The ponytail plugin changes every session.** Its Claude Code plugin registers `SessionStart`, `SubagentStart`, and `UserPromptSubmit` hooks. By default it also writes a per-task ledger to `~/.config/ponytail/band/<project>.csv`. The skill text says it stays "Active for the whole session". `INSTALL.md` also lists a skills-only route, `npx skills add DietrichGebert/ponytail`. Whether that route skips the hooks is unconfirmed.
6. **Many of these skills can't run unattended as installed.** These skills set `disable-model-invocation: true`: `grill-with-docs`, `to-spec`, `to-tickets`, `triage`, `technical-writing`, `watch-pr`, `implement`, `implement-spec`, and `retro`. The Claude Code skills docs say such a skill can't be invoked by Claude on its own and can't be preloaded into a subagent. It also doesn't run when a scheduled task fires with the skill as its prompt. The board runs `/triage` from a routine that starts one subagent per group.
7. **Skill names collide.** In Claude Code, a personal skill in `~/.claude/skills` wins over a project skill with the same name. Plugin skills load alongside both, under a `/plugin-name:skill-name` namespace. If Flight Deck ships these as project skills, a user who already has a personal `tdd`, `triage`, `code-review`, `unslop`, or `technical-writing` gets their own copy, not Flight Deck's. skills.sh also lists the upstream `unslop` from `cursor/plugins`, an unrelated `unslop` from `theclaymethod/unslop`, and an unrelated `technical-writing` skill from `vercel/eve`. A `code-review` skill replaces Claude Code's bundled `/code-review`.
8. **The upstream skills read files from the repo.** `/setup-matt-pocock-skills` writes `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, and `docs/agents/domain.md`. It ships tracker templates for GitHub, GitLab, and local files, with none for Linear. `triage`, `tdd`, `diagnosing-bugs`, and `domain-modeling` read `GLOSSARY.md`. `code-review` and `retro` read `CODING_STANDARDS.md`. Upstream `triage` uses the same state roles the board uses: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`.
9. **Three of the unwritten skills assume an npm component library.** `/story` assumes Storybook, `/changeset` assumes Changesets, and `/design-check` assumes Figma frames for every state. The board was drawn for an npm component library. The closest published `/story` skill needs Storybook 11, and the newest Storybook build it was synced from is 11.0.0-alpha.5.

## Sources

All read on 2026-10-16.

- Flight Deck FigJam board, file `NQZkqmYRJPSl1o7heDDTK0`, node `0:1`, read with `get_figjam` and section screenshots.
- `~/.claude/skills/` and `~/.agents/skills/`: directory listings, symlink targets, and each `SKILL.md` frontmatter.
- `~/.agents/.skill-lock.json`: source repo, skill path, and folder hash for each installed upstream skill.
- `~/agent-config/README.md`, `scripts/bootstrap.sh`, `.gitmodules`, and `git log`. Remote `git@github.com:campdotdev/agent-config.git`, which `gh repo view` reports as private with no license.
- [mattpocock/skills](https://github.com/mattpocock/skills) at `49dd158` (2026-10-09): `LICENSE`, `README.md`, `CHANGELOG.md`, the `skills/` tree, and the history for `resolving-merge-conflicts` (`daa01d8`, `153fc1b`).
- [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) at `16352ac` (2026-10-16): `LICENSE`, `skills/ponytail/SKILL.md`, `skills/ponytail-review/SKILL.md`, `.claude-plugin/plugin.json`, `hooks/claude-codex-hooks.json`, and `INSTALL.md`.
- [cursor/plugins, pstack](https://github.com/cursor/plugins/tree/main/pstack/skills) at `bc697d0` (2026-10-12): `pstack/LICENSE`, the `pstack/skills` listing, and `technical-writing` and `unslop` `SKILL.md`, diffed against the copies in `~/agent-config/skills`.
- [blader/humanizer](https://github.com/blader/humanizer) at `8c307f3`: `LICENSE` and `SKILL.md`, compared through the copy at `~/agent-config/skills/humanizer`.
- [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing): page footer license.
- [evildmp/diataxis-documentation-framework](https://github.com/evildmp/diataxis-documentation-framework): `LICENSE.rst`.
- [Google developer documentation style guide](https://developers.google.com/style): page footer license.
- [storybookjs/skills](https://github.com/storybookjs/skills), branch `next` at `6caf69d`: `skills/stories/SKILL.md` and the missing LICENSE. [storybookjs/storybook](https://github.com/storybookjs/storybook): license and `code/core/src/cli/skills`.
- [changesets](https://github.com/changesets) org repository list.
- GitHub code search for `SKILL.md` files named `ponytail`, `standards-review`, `design-check`, `resolving-merge-conflicts`, `changeset`, and Storybook stories, with each hit's repository license.
- skills.sh search API (`https://skills.sh/api/search?q=<name>`) for each unwritten or colliding name.
- [Claude Code skills docs](https://code.claude.com/docs/en/skills): `disable-model-invocation`, plugin namespacing, and name precedence.
