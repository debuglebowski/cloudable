import { describe, expect, test } from "bun:test";
import { type EnsureInput, type LastEnsureAction, SETTLE_MS, decideEnsureActions } from "./ensure";
import type { ResolvedManifestEntry } from "./manifest";

const NOW = new Date("2026-11-20T12:00:00Z");
const HOUR = 60 * 60 * 1000;

const entry = (overrides: Partial<ResolvedManifestEntry> = {}): ResolvedManifestEntry => ({
  packageName: "ripgrep",
  versionPin: null,
  locked: false,
  excluded: false,
  partOf: null,
  description: null,
  setting: "ensure_installed",
  source: "org",
  resolvedFromScopeId: "org-1",
  ...overrides,
});

const input = (overrides: Partial<EnsureInput> = {}): EnsureInput => ({
  manifest: [entry()],
  installedPackages: [],
  installedVersions: {},
  availableVersions: {},
  baselinePackages: new Set(),
  outstanding: new Set(),
  lastEnsureActions: new Map(),
  retryWaitMs: 24 * HOUR,
  now: NOW,
  ...overrides,
});

const last = (overrides: Partial<LastEnsureAction> = {}): LastEnsureAction => ({
  status: "failed",
  trigger: "ensure_installed",
  finishedAt: new Date(NOW.getTime() - HOUR),
  ...overrides,
});

const names = (decisions: ReturnType<typeof decideEnsureActions>) =>
  decisions.map((decision) => decision.packageName);

describe("decideEnsureActions", () => {
  test("installs a missing Ensure installed package, with its pin", () => {
    const decisions = decideEnsureActions(input({ manifest: [entry({ versionPin: "14.1.0-1" })] }));
    expect(decisions).toEqual([
      {
        packageName: "ripgrep",
        trigger: "ensure_installed",
        versionPin: "14.1.0-1",
        reason: "missing",
        installedVersion: null,
        availableVersion: null,
      },
    ]);
  });

  test("does nothing for an Allowed package, missing or not", () => {
    expect(decideEnsureActions(input({ manifest: [entry({ setting: "allowed" })] }))).toEqual([]);
  });

  test("does nothing before the agent has ever reported", () => {
    expect(decideEnsureActions(input({ installedPackages: null }))).toEqual([]);
  });

  test("never updates an Ensure installed package that is behind", () => {
    const decisions = decideEnsureActions(
      input({
        installedPackages: ["ripgrep"],
        installedVersions: { ripgrep: "13.0.0" },
        availableVersions: { ripgrep: "14.1.0" },
      }),
    );
    expect(decisions).toEqual([]);
  });

  test("replaces an Ensure installed package that does not match its pin", () => {
    const nodejs = entry({ packageName: "nodejs", versionPin: "24.*" });
    const decisions = decideEnsureActions(
      input({
        manifest: [nodejs],
        installedPackages: ["nodejs"],
        installedVersions: { nodejs: "18.19.1+dfsg-6ubuntu5" },
        availableVersions: { nodejs: "24.22.3-1nodesource1" },
      }),
    );
    expect(decisions).toEqual([
      {
        packageName: "nodejs",
        trigger: "ensure_installed",
        versionPin: "24.*",
        reason: "pin_mismatch",
        installedVersion: "18.19.1+dfsg-6ubuntu5",
        availableVersion: "24.22.3-1nodesource1",
      },
    ]);
    // A version the pin allows is left alone, even when a newer one is offered.
    expect(
      decideEnsureActions(
        input({
          manifest: [nodejs],
          installedPackages: ["nodejs"],
          installedVersions: { nodejs: "24.22.0-1nodesource1" },
          availableVersions: { nodejs: "24.22.3-1nodesource1" },
        }),
      ),
    ).toEqual([]);
  });

  test("a pin-mismatch install that succeeded and changed nothing waits the retry time", () => {
    const decisions = decideEnsureActions(
      input({
        manifest: [entry({ packageName: "nodejs", versionPin: "24.*" })],
        installedPackages: ["nodejs"],
        installedVersions: { nodejs: "18.19.1" },
        lastEnsureActions: new Map([["nodejs", last({ status: "succeeded" })]]),
      }),
    );
    expect(decisions).toEqual([]);
  });

  test("other managers' pins are not judged, and the image's packages are never touched", () => {
    expect(
      decideEnsureActions(
        input({
          manifest: [entry({ packageName: "npm:typescript", versionPin: "^5.0.0" })],
          installedPackages: ["npm:typescript"],
          installedVersions: { "npm:typescript": "4.9.5" },
        }),
      ),
    ).toEqual([]);
    expect(
      decideEnsureActions(
        input({
          manifest: [entry({ packageName: "nodejs", versionPin: "24.*" })],
          installedPackages: ["nodejs"],
          installedVersions: { nodejs: "18.19.1" },
          baselinePackages: new Set(["nodejs"]),
        }),
      ),
    ).toEqual([]);
  });

  test("updates an Ensure latest version package that is behind", () => {
    const decisions = decideEnsureActions(
      input({
        manifest: [entry({ setting: "ensure_latest" })],
        installedPackages: ["ripgrep"],
        installedVersions: { ripgrep: "13.0.0" },
        availableVersions: { ripgrep: "14.1.0" },
      }),
    );
    expect(decisions).toEqual([
      {
        packageName: "ripgrep",
        trigger: "ensure_latest",
        versionPin: null,
        reason: "outdated",
        installedVersion: "13.0.0",
        availableVersion: "14.1.0",
      },
    ]);
  });

  test("leaves an up-to-date Ensure latest version package alone", () => {
    const decisions = decideEnsureActions(
      input({
        manifest: [entry({ setting: "ensure_latest" })],
        installedPackages: ["ripgrep"],
        installedVersions: { ripgrep: "14.1.0" },
        availableVersions: { ripgrep: "14.1.0" },
      }),
    );
    expect(decisions).toEqual([]);
  });

  test("an agent that does not report available versions gets installs but no updates", () => {
    const decisions = decideEnsureActions(
      input({
        manifest: [
          entry({ setting: "ensure_latest" }),
          entry({ packageName: "jq", setting: "ensure_latest" }),
        ],
        installedPackages: ["ripgrep"],
        installedVersions: { ripgrep: "13.0.0" },
      }),
    );
    expect(names(decisions)).toEqual(["jq"]);
  });

  test("skips excluded entries, orphaned parts, other managers and the image baseline", () => {
    const decisions = decideEnsureActions(
      input({
        manifest: [
          entry({ packageName: "excluded-one", excluded: true }),
          entry({ packageName: "orphan", partOf: "missing-parent" }),
          entry({ packageName: "home:chromium" }),
          entry({ packageName: "curl" }),
          entry({ packageName: "jq" }),
        ],
        baselinePackages: new Set(["curl"]),
      }),
    );
    expect(names(decisions)).toEqual(["jq"]);
  });

  test("waits while an action for the package is outstanding", () => {
    expect(decideEnsureActions(input({ outstanding: new Set(["ripgrep"]) }))).toEqual([]);
  });

  test("waits the org's retry time after a failed or expired try, then tries again", () => {
    const failedRecently = new Map([
      ["ripgrep", last({ finishedAt: new Date(NOW.getTime() - HOUR) })],
    ]);
    expect(decideEnsureActions(input({ lastEnsureActions: failedRecently }))).toEqual([]);

    const expiredLongAgo = new Map([
      ["ripgrep", last({ status: "expired", finishedAt: new Date(NOW.getTime() - 25 * HOUR) })],
    ]);
    expect(names(decideEnsureActions(input({ lastEnsureActions: expiredLongAgo })))).toEqual([
      "ripgrep",
    ]);

    expect(
      names(
        decideEnsureActions(input({ lastEnsureActions: failedRecently, retryWaitMs: HOUR / 2 })),
      ),
    ).toEqual(["ripgrep"]);
  });

  test("does not queue the same change twice while reports catch up", () => {
    const justSucceeded = new Map([
      [
        "ripgrep",
        last({ status: "succeeded", finishedAt: new Date(NOW.getTime() - SETTLE_MS / 2) }),
      ],
    ]);
    expect(decideEnsureActions(input({ lastEnsureActions: justSucceeded }))).toEqual([]);
  });

  test("an update that succeeded but left the package behind waits the retry time", () => {
    const updatedButBehind = input({
      manifest: [entry({ setting: "ensure_latest" })],
      installedPackages: ["ripgrep"],
      installedVersions: { ripgrep: "13.0.0" },
      availableVersions: { ripgrep: "14.1.0" },
      lastEnsureActions: new Map([
        [
          "ripgrep",
          last({
            status: "succeeded",
            trigger: "ensure_latest",
            finishedAt: new Date(NOW.getTime() - HOUR),
          }),
        ],
      ]),
    });
    expect(decideEnsureActions(updatedButBehind)).toEqual([]);
  });
});
