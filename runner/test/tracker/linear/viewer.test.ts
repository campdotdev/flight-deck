// Who a token or key acts as (spec 1, "Install"): `flight-deck login linear` reads the setup key's viewer for the
// maintainer, and mints one token from each app to confirm it reaches the workspace and to read the app user.
import { afterEach, describe, expect, test } from "bun:test";
import { MintFailed, TrackerRefused } from "../../../src/tracker/index.ts";
import type { FakeLinear, Received } from "./fake-linear.ts";
import { world } from "./linear-world.ts";

let linear: FakeLinear;
afterEach(() => linear.stop());

/** Linear's answer to the viewer query: who the request's token or key belongs to. */
function viewers(by: Record<string, { id: string; name: string; urlKey?: string }>) {
  return (_variables: Record<string, unknown>, request: Received) => {
    const who = by[request.authorization ?? ""];
    if (who === undefined) throw new Error(`no viewer for ${request.authorization}`);
    return { data: { viewer: { id: who.id, name: who.name, organization: { urlKey: who.urlKey ?? "campdotdev" } } } };
  };
}

describe("viewer", () => {
  test("reads the setup key's user and the workspace it reaches, sending the key as it is", async () => {
    const setup = world({ kind: "setup_key", key: "lin_api_setup" });
    linear = setup.linear;
    linear.on("FlightDeckIdentity", viewers({ lin_api_setup: { id: "user-maintainer", name: "Hunter" } }));
    expect(await setup.tracker.viewer("campdotdev")).toEqual({ id: "user-maintainer", name: "Hunter", workspace: "campdotdev" });
    expect(linear.mints).toEqual([]);
  });

  test("a setup key Linear rejects is refused, not retried", async () => {
    const setup = world({ kind: "setup_key", key: "lin_api_setup" });
    linear = setup.linear;
    linear.accepted.delete("lin_api_setup");
    const error = await setup.tracker.viewer("campdotdev").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TrackerRefused);
    expect((error as Error).message).toBe("Linear rejected the setup key for campdotdev");
  });
});

describe("appViewer", () => {
  test("mints one token from the app, reads its viewer with it, and revokes it", async () => {
    const setup = world({ kind: "setup_key", key: "lin_api_setup" });
    linear = setup.linear;
    linear.on(
      "FlightDeckIdentity",
      viewers({
        "Bearer lin_oauth_fd-client_1": { id: "user-app", name: "Flight Deck" },
        "Bearer lin_oauth_reader-client_2": { id: "user-reader", name: "Flight Deck Reader", urlKey: "other" },
      }),
    );
    expect(await setup.tracker.appViewer("campdotdev", "flight_deck")).toEqual({ id: "user-app", name: "Flight Deck", workspace: "campdotdev" });
    expect(await setup.tracker.appViewer("campdotdev", "reader")).toEqual({ id: "user-reader", name: "Flight Deck Reader", workspace: "other" });
    expect(linear.mints.map((form) => [form.client_id, form.scope])).toEqual([
      ["fd-client", "read,write"],
      ["reader-client", "read"],
    ]);
    expect(linear.revokes).toEqual(["lin_oauth_fd-client_1", "lin_oauth_reader-client_2"]);
    expect(linear.accepted.has("lin_oauth_fd-client_1")).toBe(false);
  });

  test("a wrong secret throws MintFailed naming the app, and nothing is left to revoke", async () => {
    const setup = world();
    linear = setup.linear;
    linear.apps.set("reader-client", "rotated");
    const error = (await setup.tracker.appViewer("campdotdev", "reader").catch((caught: unknown) => caught)) as MintFailed;
    expect(error).toBeInstanceOf(MintFailed);
    expect(error.app).toBe("reader");
    expect(error.message).toBe("Linear refused to mint a Flight Deck Reader token for campdotdev: HTTP 401 invalid_client: Client authentication failed");
    expect(linear.revokes).toEqual([]);
  });

  test("revokes the token even when the viewer read fails", async () => {
    const setup = world();
    linear = setup.linear;
    linear.on("FlightDeckIdentity", { status: 400, errors: [{ message: "bad", extensions: { code: "INVALID_INPUT" } }] });
    await expect(setup.tracker.appViewer("campdotdev", "flight_deck")).rejects.toBeInstanceOf(TrackerRefused);
    expect(linear.revokes).toEqual(["lin_oauth_fd-client_1"]);
  });
});
