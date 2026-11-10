# Tracker fixtures

- `linear-schema.graphql`: Linear's public GraphQL schema, copied unchanged from `packages/sdk/src/schema.graphql` in [linear/linear](https://github.com/linear/linear) at commit `76164675dfd29f26a09ea124d7b6b9e04b542693` (2026-11-04). The Linear adapter's tests check every document the adapter sends, and its variables, against it. Replace it with a newer copy when Linear changes its API, and rerun `bun test test/tracker`.

The answers the fake Linear in `test/tracker/linear/` gives are written by hand in the schema's shape, not recorded from real Linear. FLD-116's contract suite runs the adapter against real Linear and pins the fields listed in `~/.flight-deck-notes/fld-75/notes/FLD-111.md`.
