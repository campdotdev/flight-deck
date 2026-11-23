# Flight Deck

Flight Deck is a software factory a solo developer adds to a repo. Two skills, `/flight-build` and `/flight-check`, take a labelled issue to a reviewed pull request. The maintainer runs them by hand or from Claude Desktop scheduled tasks, and approves every merge.

The skills are not written yet. Build them one small issue at a time, and add a feature only after real use shows the need for it.

## The archived design

An earlier design had a runner program, 28 ADRs, and ten specs. The tag `archive/runner-plan` keeps it. Do not build from it or propose its pieces. A piece returns only after the skills have failed the same way twice in real use.

The archive's ADRs and research notes hold tested facts about Claude Code, Linear, and GitHub. When a skill needs one, read it from the tag:

```sh
git show archive/runner-plan:docs/adr/0010-review-bots-see-a-pr-only-after-check-passes-it.md
```

## Agent skills

### Issue tracker

Linear, on the Flight Deck team (`FLD-`), through the Linear MCP server. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the root. See `docs/agents/domain.md`.

### Bundled skills

`skills/` holds the copies and forks that the flows read as files. `CREDITS.md` names each one's upstream and commit. The `brief` and `reproducing-bugs` forks still mention the runner, and the issue that writes `/flight-build` updates them.
