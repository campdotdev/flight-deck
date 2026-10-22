# Flows read pinned copies of the skills they follow

Flight Deck's flows follow skills that other authors wrote: Matt Pocock's skills, pstack, and ponytail. Those upstreams change often. Matt Pocock removed `resolving-merge-conflicts` on 2026-09-24, and a version range can't resolve against his tags. If a flow followed the latest upstream, check could judge two commits of one repo by different rules, and a third party could change what a session with commit access does without anyone reading the change. So every skill a factory session follows sits in Flight Deck's repo at a known commit. It is a copy of an upstream skill, a fork that opens with a comment naming its upstream path, its commit, and what changed, or Flight Deck's own text. An upstream change reaches a factory only in a new Flight Deck version, after someone reads the diff. Flows read each skill's `SKILL.md` as a file and follow it instead of invoking it, because nine of the skills they use set `disable-model-invocation: true`.

## Considered options

- **Depend on the upstream at run time,** through a plugin `dependencies` entry or `ctx7 skills install`. Fixes would arrive without a new Flight Deck version, but the version would float, and `claude-plugins-official` updates plugins automatically by default.
- **Ship registered, namespaced skills,** such as `flight-deck:tdd`, that flows invoke through the Skill tool, with the flag removed in each fork. Every fork would then appear in the maintainer's own sessions wherever Flight Deck is installed, beside the maintainer's own `tdd`.

## Consequences

- Flight Deck's copies and forks are files beside the flows, not registered skills. The runner hands each flow the path of every slot skill the repo record names, and the flow reads it the same way.
- The one exception is a skill the repo keeps in its own `.claude/skills/`, which the repo record can name in a slot. The session reads it at the commit it works on, so the repo's own history pins it. Flight Deck neither copies nor reviews it.
- A skill whose plugin adds hooks, such as ponytail, runs without them. All of ponytail's rules are in its `SKILL.md`, and its hooks only inject that text again at each prompt and subagent.
- Flight Deck's repo is MIT. One `CREDITS.md` at the root holds each upstream's notice and the commit Flight Deck copied. When Flight Deck's own text borrows a rule, the credit goes in `CREDITS.md`, not in the skill, so sessions spend no tokens on it.
- Flight Deck never installs skills with `ctx7`. Context7's MCP server is a docs source that setup offers and the maintainer opts into.
- Fork a skill when Flight Deck keeps the upstream's steps. Write Flight Deck's own text when it keeps only a rule or two, or blends several sources.
