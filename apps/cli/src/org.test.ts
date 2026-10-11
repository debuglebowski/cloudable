import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { UsageError } from "./errors";
import * as realHttpClient from "./http-client";

// `org update` talks to the API only through `authenticatedApiRequest`, so that one export
// is replaced and the rest of the module stays real. What is under test is which fields the
// command decides to send, not the network.
let sent: unknown[] = [];

const org = {
  id: "org-1",
  name: "Acme",
  approvalModes: {},
  loggingTier: 2,
  loggingTierOverrideCount: 0,
  retentionDefaultDays: 30,
  eventRetentionDays: 365,
  retentionLocation: "customer",
};

mock.module("./http-client", () => ({
  ...realHttpClient,
  authenticatedApiRequest: async (_path: string, init?: RequestInit) => {
    sent.push(init?.body ? JSON.parse(String(init.body)) : undefined);
    return org;
  },
}));

const { runOrgUpdateCommand } = await import("./org");

let log: ReturnType<typeof spyOn>;
beforeEach(() => {
  sent = [];
  log = spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => log.mockRestore());

test("--event-retention-days is sent as eventRetentionDays, apart from the snapshot window", async () => {
  await runOrgUpdateCommand(["--event-retention-days", "180"]);
  expect(sent).toEqual([{ eventRetentionDays: 180 }]);
});

test("the two retention flags are separate settings and can be given together", async () => {
  await runOrgUpdateCommand(["--retention-days", "45", "--event-retention-days", "500"]);
  expect(sent).toEqual([{ retentionDefaultDays: 45, eventRetentionDays: 500 }]);
});

test("any two changes at once are accepted (exactly two used to be refused as 'nothing to change')", async () => {
  await runOrgUpdateCommand(["--name", "Acme", "--logging-tier", "1"]);
  expect(sent).toEqual([{ name: "Acme", loggingTier: 1 }]);
});

test("giving no change at all is a usage error and sends nothing", async () => {
  await expect(runOrgUpdateCommand([])).rejects.toBeInstanceOf(UsageError);
  expect(sent).toEqual([]);
});

test("a value that is not a whole number of days is refused before anything is sent", async () => {
  await expect(runOrgUpdateCommand(["--event-retention-days", "abc"])).rejects.toBeInstanceOf(
    UsageError,
  );
  await expect(runOrgUpdateCommand(["--event-retention-days", "12.5"])).rejects.toBeInstanceOf(
    UsageError,
  );
  expect(sent).toEqual([]);
});
