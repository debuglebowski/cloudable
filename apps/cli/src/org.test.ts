import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { EXIT, UsageError } from "./errors";
import * as realHttpClient from "./http-client";

// `org update` talks to the API only through `authenticatedApiRequest`, so that one export
// is replaced and the rest of the module stays real. What is under test is which fields the
// command decides to send, not the network.
//
// This file also holds the request-routing tests for the vulnerability scanning commands. Bun
// keeps a `mock.module` for the whole test run, and `org.ts` imports `vulnerability-scan.ts`, so
// a second file mocking this same module would be talking to whichever mock loaded first. One
// mock, answering by path, is the safe shape.
let sent: unknown[] = [];
let paths: string[] = [];
let texts: string[] = [];
// When set, the next scan settings write is refused the way the control plane refuses a non-admin.
let refuseScanWrite = false;

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

const scanView = {
  settings: {
    enabled: true,
    scanner: "trivy",
    scope: "os",
    scanDays: ["sun"],
    scanTimeUtc: "02:00",
    remediationDays: { critical: 7, high: 30 },
    dbRepository: null,
  },
  scanner: { name: "trivy", version: "0.75.0" },
  fleet: {
    machines: 2,
    byStatus: { disabled: 0, never_scanned: 1, current: 1, overdue: 0, stopped: 0 },
    openCritical: 0,
    openHigh: 1,
  },
};

const machineView = {
  machineId: "5f1d3a9e-0000-4000-8000-000000000001",
  status: "current",
  installedScanner: { name: "trivy", version: "0.75.0" },
  lastScan: null,
  lastFailure: null,
  dbStale: false,
  open: { counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }, fixable: 0 },
  findings: [],
};

mock.module("./http-client", () => ({
  ...realHttpClient,
  authenticatedApiRequest: async (path: string, init?: RequestInit) => {
    paths.push(path);
    sent.push(init?.body ? JSON.parse(String(init.body)) : undefined);
    if (path === "/api/v1/vulnerability-scan" && init?.method === "PATCH" && refuseScanWrite) {
      throw new realHttpClient.ApiError(403, {
        _tag: "AdminRoleRequiredError",
        reason: "Only an admin can change vulnerability scanning.",
      });
    }
    if (path === "/api/v1/vulnerability-scan") return scanView;
    if (path.endsWith("/vulnerabilities")) return machineView;
    return org;
  },
  authenticatedApiText: async (path: string) => {
    texts.push(path);
    return "machine_id,vulnerability_id\n";
  },
}));

const { runOrgUpdateCommand } = await import("./org");

let log: ReturnType<typeof spyOn>;
beforeEach(() => {
  sent = [];
  paths = [];
  texts = [];
  refuseScanWrite = false;
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

test("the scanning flags are one PATCH to the vulnerability scan endpoint, not the organisation one", async () => {
  await runOrgUpdateCommand([
    "--vulnerability-scan",
    "on",
    "--scan-days",
    "wed,sun",
    "--scan-time",
    "03:30",
    "--remediation-critical",
    "3",
    "--remediation-high",
    "14",
    "--vuln-db-repository",
    "registry.example.com/mirrors/trivy-db",
  ]);
  expect(paths).toEqual(["/api/v1/vulnerability-scan"]);
  expect(sent).toEqual([
    {
      enabled: true,
      scanDays: ["sun", "wed"],
      scanTimeUtc: "03:30",
      remediationDays: { critical: 3, high: 14 },
      dbRepository: "registry.example.com/mirrors/trivy-db",
    },
  ]);
});

test("turning scanning on says what that does, and that it is recorded", async () => {
  await runOrgUpdateCommand(["--vulnerability-scan", "on"]);
  const out = log.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
  expect(out).toContain("installed on every machine in the org");
  expect(out).toContain("The change is recorded.");
});

test("organisation flags and scanning flags together make one request each", async () => {
  await runOrgUpdateCommand(["--name", "Acme", "--scan-time", "04:00"]);
  expect(paths).toEqual(["/api/v1/organisation", "/api/v1/vulnerability-scan"]);
  expect(sent).toEqual([{ name: "Acme" }, { scanTimeUtc: "04:00" }]);
});

test("a bad scanning flag stops everything before any request, even next to a good org flag", async () => {
  await expect(
    runOrgUpdateCommand(["--name", "Acme", "--scan-days", "funday"]),
  ).rejects.toBeInstanceOf(UsageError);
  await expect(runOrgUpdateCommand(["--scan-time", "25:00"])).rejects.toBeInstanceOf(UsageError);
  await expect(runOrgUpdateCommand(["--vulnerability-scan", "maybe"])).rejects.toBeInstanceOf(
    UsageError,
  );
  expect(paths).toEqual([]);
});

test("--vuln-db-repository none sends a null, which clears the mirror", async () => {
  await runOrgUpdateCommand(["--vuln-db-repository", "none"]);
  expect(sent).toEqual([{ dbRepository: null }]);
});

test("--json with only a scanning change prints the scanning view as it came back", async () => {
  await runOrgUpdateCommand(["--vulnerability-scan", "off", "--json"]);
  expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual(scanView);
});

test("--json with both prints them side by side under their own names", async () => {
  await runOrgUpdateCommand(["--name", "Acme", "--scan-time", "04:00", "--json"]);
  const printed = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(Object.keys(printed).sort()).toEqual(["organisation", "vulnerabilityScan"]);
});

test("org vulnerability-scan reads the settings and fleet summary", async () => {
  const { runOrgVulnerabilityScanCommand } = await import("./vulnerability-scan");
  await runOrgVulnerabilityScanCommand([]);
  expect(paths).toEqual(["/api/v1/vulnerability-scan"]);
  expect(sent).toEqual([undefined]);
  expect(log.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n")).toContain(
    "trivy 0.75.0",
  );
});

test("machines vulnerabilities asks the machine's own endpoint, by id", async () => {
  const { runMachinesVulnerabilitiesCommand } = await import("./vulnerability-scan");
  await runMachinesVulnerabilitiesCommand(["5f1d3a9e-0000-4000-8000-000000000001"]);
  expect(paths).toEqual(["/api/v1/machines/5f1d3a9e-0000-4000-8000-000000000001/vulnerabilities"]);
});

test("machines vulnerabilities needs a machine", async () => {
  const { runMachinesVulnerabilitiesCommand } = await import("./vulnerability-scan");
  await expect(runMachinesVulnerabilitiesCommand([])).rejects.toBeInstanceOf(UsageError);
  expect(paths).toEqual([]);
});

test("export vulnerabilities fetches the CSV from the compliance exports, with no org id", async () => {
  const { runExportVulnerabilitiesCommand } = await import("./compliance");
  const write = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await runExportVulnerabilitiesCommand([]);
    expect(texts).toEqual(["/api/v1/compliance/exports/vulnerabilities.csv"]);
    expect(write).toHaveBeenCalledWith("machine_id,vulnerability_id\n");
  } finally {
    write.mockRestore();
  }
});

test("a person who is not an admin is told why, and the exit code says denied", async () => {
  refuseScanWrite = true;
  const error = await runOrgUpdateCommand(["--vulnerability-scan", "on"]).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(realHttpClient.ApiError);
  const refused = error as InstanceType<typeof realHttpClient.ApiError>;
  expect(refused.message).toContain("Only an admin can change vulnerability scanning.");
  expect(refused.exitCode).toBe(EXIT.denied);
});
