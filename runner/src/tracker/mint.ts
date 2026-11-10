// A token mint Linear refused (spec 1, "Tokens", ADR 0005). Each workspace has two apps: the Flight Deck app,
// whose token the runner holds for its own reads and writes, and Flight Deck Reader, which mints one read-only
// token per session. A failed mint is a kind of `TrackerUnavailable`, so a write that needed a fresh token, such
// as after a 401, is kept and tried again like any write Linear didn't take.
import { TrackerUnavailable } from "./unavailable.ts";

/** Which of the workspace's two apps a token comes from. */
export type LinearApp = "flight_deck" | "reader";

export class MintFailed extends TrackerUnavailable {
  constructor(
    readonly app: LinearApp,
    readonly workspace: string,
    message = `Linear refused to mint a ${app === "reader" ? "Flight Deck Reader" : "Flight Deck"} token for ${workspace}`,
  ) {
    super("mint", message);
    this.name = "MintFailed";
  }
}
