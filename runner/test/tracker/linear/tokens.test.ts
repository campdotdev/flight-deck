// The Linear adapter's tokens and identities, and how it sorts Linear's answers (spec 1, "Tokens" and
// "Session credentials", ADR 0005).
import { afterEach, describe, expect, test } from "bun:test";
import { isUnavailable, MintFailed, TrackerRefused, TrackerUnavailable } from "../../../src/tracker/index.ts";
import { invalidInput, RATELIMITED, UNAUTHENTICATED, type FakeLinear } from "./fake-linear.ts";
import { repo, world } from "./linear-world.ts";

const session = { id: "20261110-0900-ab12", repo };

let linear: FakeLinear;
afterEach(() => linear.stop());

describe("the runner's Flight Deck token", () => {
  test("is minted once with the client-credentials grant and scopes read and write, and every call sends it", async () => {
    const setup = world();
    linear = setup.linear;
    await setup.tracker.runnerToken("campdotdev");
    await setup.tracker.runnerToken("campdotdev");
    await setup.tracker.checkTeam(repo);
    expect(linear.mints).toEqual([{ grant_type: "client_credentials", scope: "read,write", client_id: "fd-client", client_secret: "fd-secret" }]);
    expect(linear.sent("FlightDeckTeam")[0]!.authorization).toBe("Bearer lin_oauth_fd-client_1");
  });

  test("a 401 drops the token, mints a new one, and tries the call once more", async () => {
    const setup = world();
    linear = setup.linear;
    await setup.tracker.runnerToken("campdotdev");
    linear.accepted.delete("lin_oauth_fd-client_1");
    expect(await setup.tracker.checkTeam(repo)).toEqual({ ok: true });
    expect(linear.sent("FlightDeckTeam").map((request) => request.authorization)).toEqual(["Bearer lin_oauth_fd-client_1", "Bearer lin_oauth_fd-client_2"]);
  });

  test("a 401 whose new mint fails throws MintFailed, a call Linear didn't take", async () => {
    const setup = world();
    linear = setup.linear;
    await setup.tracker.runnerToken("campdotdev");
    linear.accepted.delete("lin_oauth_fd-client_1");
    linear.apps.set("fd-client", "rotated");
    const error = await setup.tracker.checkTeam(repo).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MintFailed);
    expect(isUnavailable(error)).toBe(true);
    expect((error as MintFailed).app).toBe("flight_deck");
  });

  test("a refused mint throws MintFailed with Linear's reason", async () => {
    const setup = world();
    linear = setup.linear;
    linear.apps.set("fd-client", "rotated");
    const error = (await setup.tracker.runnerToken("campdotdev").catch((caught: unknown) => caught)) as MintFailed;
    expect(error).toBeInstanceOf(MintFailed);
    expect(error.workspace).toBe("campdotdev");
    expect(error.message).toBe("Linear refused to mint a Flight Deck token for campdotdev: HTTP 401 invalid_client: Client authentication failed");
  });

  test("a workspace with no app in credentials.env can't mint", async () => {
    const setup = world();
    linear = setup.linear;
    const error = (await setup.tracker.runnerToken("other").catch((caught: unknown) => caught)) as MintFailed;
    expect(error).toBeInstanceOf(MintFailed);
    expect(error.message).toBe("credentials.env has no Flight Deck app for other");
    expect(linear.mints).toEqual([]);
  });

  test("a mint Linear doesn't answer is a failed mint", async () => {
    const setup = world();
    linear = setup.linear;
    linear.mintReplies.push({ status: 503, raw: "<html>Service Unavailable</html>" });
    expect(await setup.tracker.runnerToken("campdotdev").catch((caught: unknown) => caught)).toBeInstanceOf(MintFailed);
  });

  test("a revoke posts the token to /oauth/revoke, and the next call mints again", async () => {
    const setup = world();
    linear = setup.linear;
    await setup.tracker.runnerToken("campdotdev");
    await setup.tracker.revokeRunnerToken("campdotdev");
    expect(linear.revokes).toEqual(["lin_oauth_fd-client_1"]);
    await setup.tracker.checkTeam(repo);
    expect(linear.mints).toHaveLength(2);
    await setup.tracker.revokeRunnerToken("other");
    expect(linear.revokes).toHaveLength(1);
  });
});

describe("a session's Reader token", () => {
  test("is minted at the first call with scope read, and a later call tests it with viewer and keeps it", async () => {
    const setup = world();
    linear = setup.linear;
    linear.on("FlightDeckViewer", { data: { viewer: { id: "reader-app-user" } } });
    expect(await setup.tracker.sessionToken(session)).toBe("lin_oauth_reader-client_1");
    expect(await setup.tracker.sessionToken(session)).toBe("lin_oauth_reader-client_1");
    expect(linear.mints.map((mint) => [mint.client_id, mint.scope])).toEqual([["reader-client", "read"]]);
    expect(linear.sent("FlightDeckViewer").map((request) => request.authorization)).toEqual(["Bearer lin_oauth_reader-client_1"]);
  });

  test("one Linear rejects is replaced: a new one is minted, then the old one revoked", async () => {
    const setup = world();
    linear = setup.linear;
    const first = await setup.tracker.sessionToken(session);
    linear.accepted.delete(first);
    expect(await setup.tracker.sessionToken(session)).toBe("lin_oauth_reader-client_2");
    expect(linear.revokes).toEqual([first]);
  });

  test("revoke ends it, and a session the adapter never minted for revokes nothing", async () => {
    const setup = world();
    linear = setup.linear;
    const token = await setup.tracker.sessionToken(session);
    await setup.tracker.revoke(session);
    await setup.tracker.revoke({ id: "20261110-0800-ffff", repo });
    expect(linear.revokes).toEqual([token]);
    expect(linear.accepted.has(token)).toBe(false);
  });

  test("tryReaderMint mints for no session and revokes at once", async () => {
    const setup = world();
    linear = setup.linear;
    await setup.tracker.tryReaderMint("campdotdev");
    expect(linear.revokes).toEqual(["lin_oauth_reader-client_1"]);
  });

  test("a refused Reader mint throws MintFailed for Reader", async () => {
    const setup = world();
    linear = setup.linear;
    linear.apps.delete("reader-client");
    const error = (await setup.tracker.sessionToken(session).catch((caught: unknown) => caught)) as MintFailed;
    expect(error).toBeInstanceOf(MintFailed);
    expect(error.app).toBe("reader");
  });

  test("a failed revoke is logged, not thrown", async () => {
    const setup = world();
    linear = setup.linear;
    await setup.tracker.sessionToken(session);
    linear.stop();
    await setup.tracker.revoke(session);
    expect(setup.logs[0]).toStartWith("Linear token revoke failed: ");
  });
});

describe("the maintainer's setup key, for flight-deck apply", () => {
  test("goes in the Authorization header as it is, and no Flight Deck token is minted", async () => {
    const setup = world({ kind: "setup_key", key: "lin_api_setupkey" });
    linear = setup.linear;
    await setup.tracker.runnerToken("campdotdev");
    await setup.tracker.checkTeam(repo);
    expect(linear.sent("FlightDeckTeam")[0]!.authorization).toBe("lin_api_setupkey");
    expect(linear.mints).toEqual([]);
  });

  test("a key Linear rejects is refused, not retried", async () => {
    const setup = world({ kind: "setup_key", key: "lin_api_setupkey" });
    linear = setup.linear;
    linear.accepted.delete("lin_api_setupkey");
    const error = await setup.tracker.move({ id: "SHA-1", repo }, "planning").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TrackerRefused);
    expect(linear.operations()).toEqual(["FlightDeckTeam"]);
  });
});

describe("the error mapping", () => {
  async function moveError(reply: Parameters<FakeLinear["on"]>[1]): Promise<unknown> {
    const setup = world();
    linear = setup.linear;
    linear.on("FlightDeckUpdate", reply);
    return setup.tracker.move({ id: "SHA-1", repo }, "planning").catch((caught: unknown) => caught);
  }

  test("RATELIMITED is a call Linear didn't take", async () => {
    const error = (await moveError(RATELIMITED)) as TrackerUnavailable;
    expect(error).toBeInstanceOf(TrackerUnavailable);
    expect(error.reason).toBe("rate_limited");
  });

  test("RATELIMITED in a 400's errors counts too", async () => {
    expect(((await moveError({ ...RATELIMITED, status: 400 })) as TrackerUnavailable).reason).toBe("rate_limited");
  });

  test("a 5xx, JSON or not, is a call Linear didn't take", async () => {
    expect(((await moveError({ status: 500, errors: [{ message: "Internal server error" }] })) as TrackerUnavailable).reason).toBe("server");
    expect(((await moveError({ status: 502, raw: "<html>Bad Gateway</html>" })) as TrackerUnavailable).reason).toBe("server");
  });

  test("a network error is a call Linear didn't take", async () => {
    const setup = world();
    linear = setup.linear;
    await setup.tracker.runnerToken("campdotdev");
    linear.stop();
    const error = (await setup.tracker.checkTeam(repo).catch((caught: unknown) => caught)) as TrackerUnavailable;
    expect(error).toBeInstanceOf(TrackerUnavailable);
    expect(error.reason).toBe("network");
  });

  test("an input Linear refuses is a refused write, which a later try won't fix", async () => {
    const error = await moveError(invalidInput("stateId must be a state of the issue's team"));
    expect(error).toBeInstanceOf(TrackerRefused);
    expect(isUnavailable(error)).toBe(false);
    expect((error as Error).message).toBe("Linear refused the call: stateId must be a state of the issue's team");
  });

  test("a payload with success false is a refused write", async () => {
    expect(await moveError({ data: { issueUpdate: { success: false } } })).toBeInstanceOf(TrackerRefused);
  });

  test("an unauthenticated answer to a fresh token is a failed mint", async () => {
    expect(await moveError(UNAUTHENTICATED)).toBeInstanceOf(MintFailed);
  });
});

