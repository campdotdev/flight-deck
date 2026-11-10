import { expect, test } from "bun:test";
import { linearApps } from "../../src/install/index.ts";

test("linearApps reads both Linear apps of a workspace from credentials.env, and null for a missing pair", () => {
  const credentials = {
    mode: 0o600,
    values: { LINEAR_APP_ID_CAMP_DEV: "fd-id", LINEAR_APP_SECRET_CAMP_DEV: "fd-secret", LINEAR_READER_ID_CAMP_DEV: "reader-id", LINEAR_READER_SECRET_CAMP_DEV: "" },
  };
  expect(linearApps(credentials, "camp-dev")).toEqual({ flight_deck: { id: "fd-id", secret: "fd-secret" }, reader: null });
  expect(linearApps(null, "camp-dev")).toBeNull();
});
