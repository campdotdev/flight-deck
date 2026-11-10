// Every document the Linear adapter sends is valid against Linear's public schema, and each query stays under
// Linear's 10,000-point cap per request (spec 1, "Polls"). The cost follows Linear's rate-limiting docs: 0.1 per
// scalar field, 1 per object, and a connection multiplies its children by its `first` or `last`, or by 50.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { buildSchema, Kind, parse, validate, type FieldNode, type SelectionSetNode } from "graphql";
import * as Q from "../../../src/tracker/linear/queries.ts";

const schema = buildSchema(readFileSync(join(import.meta.dir, "..", "fixtures", "linear-schema.graphql"), "utf8"), { assumeValidSDL: true });

const DOCUMENTS: [string, string][] = Object.entries(Q as Record<string, unknown>).flatMap(([name, value]) => (typeof value === "string" ? [[name, value] as [string, string]] : []));

function cost(selections: SelectionSetNode | undefined): number {
  let total = 0;
  for (const selection of selections?.selections ?? []) {
    if (selection.kind !== Kind.FIELD) continue;
    total += fieldCost(selection);
  }
  return total;
}

function fieldCost(field: FieldNode): number {
  if (field.selectionSet === undefined) return field.name.value === "__typename" ? 0 : 0.1;
  const size = field.arguments?.find((argument) => argument.name.value === "first" || argument.name.value === "last");
  const connection = field.selectionSet.selections.some((each) => each.kind === Kind.FIELD && each.name.value === "nodes");
  const multiplier = size?.value.kind === Kind.INT ? Number(size.value.value) : connection ? 50 : 1;
  return 1 + multiplier * cost(field.selectionSet);
}

describe("the Linear adapter's GraphQL documents", () => {
  for (const [name, document] of DOCUMENTS) {
    test(`${name} is valid against Linear's schema`, () => {
      expect(validate(schema, parse(document)).map((error) => error.message)).toEqual([]);
    });
  }

  test("each query costs under 10,000 points", () => {
    const costs = Object.fromEntries(
      DOCUMENTS.filter(([, document]) => document.startsWith("query")).map(([name, document]) => {
        const operation = parse(document).definitions[0]!;
        return [name, operation.kind === Kind.OPERATION_DEFINITION ? Math.ceil(cost(operation.selectionSet)) : 0];
      }),
    );
    for (const [name, points] of Object.entries(costs)) expect({ name, under: points < 10_000 }).toEqual({ name, under: true });
    // The heaviest, pinned so a change to their fields shows here.
    expect(costs).toMatchObject({ SNAPSHOT_ISSUES: 6147, BLOCKERS: 6517, DUPLICATE_LINKS: 1331, ISSUE: 844, COMMENTS: 801, TEAM: 134 });
  });
});
