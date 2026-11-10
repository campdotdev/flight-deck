// The Linear half's own GraphQL is valid against Linear's public schema, so a run on the maintainer's Mac never
// fails on a misspelled field.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSchema, parse, validate } from "graphql";
import * as Q from "./linear-queries.ts";

const schema = buildSchema(readFileSync(join(import.meta.dir, "../../tracker/fixtures/linear-schema.graphql"), "utf8"), { assumeValidSDL: true });

describe("the Linear contract suite's GraphQL", () => {
  for (const [name, document] of Object.entries(Q)) {
    test(`${name} is valid against Linear's schema`, () => {
      expect(validate(schema, parse(document)).map((error) => error.message)).toEqual([]);
    });
  }
});
