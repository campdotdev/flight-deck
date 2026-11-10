// Which production-adapter parts of the contract suites run. They need the maintainer's credentials and Mac, so
// `bun test` in CI skips them: each runs only when `FLIGHT_DECK_CONTRACT` names it (spec 1, "Suites"). The
// in-memory and scripted halves always run.

/** The parts that reach real Linear or start a real `claude -p` session. */
export const CONTRACT_PARTS = ["tracker", "harness", "lockdown", "instructions"] as const;

export type ContractPart = (typeof CONTRACT_PARTS)[number];

/**
 * The parts `FLIGHT_DECK_CONTRACT` names: `1` or `all` for every part, or a comma-separated list such as
 * `tracker,harness`. Unset, empty, or `0` runs none.
 */
export function contractParts(value: string | undefined): Set<ContractPart> {
  const text = (value ?? "").trim();
  if (text === "" || text === "0") return new Set();
  if (text === "1" || text === "all") return new Set(CONTRACT_PARTS);
  const parts = new Set<ContractPart>();
  for (const word of text.split(",").map((each) => each.trim()).filter((each) => each !== "")) {
    if (!(CONTRACT_PARTS as readonly string[]).includes(word)) {
      throw new Error(`FLIGHT_DECK_CONTRACT names ${word}, which isn't a part. The parts are ${CONTRACT_PARTS.join(", ")}, or 1 for all of them.`);
    }
    parts.add(word as ContractPart);
  }
  return parts;
}

/** Whether this run includes the part. */
export function runs(part: ContractPart): boolean {
  return contractParts(process.env.FLIGHT_DECK_CONTRACT).has(part);
}
