import { describe, expect, test } from "bun:test";
import type { PendingPackageActionView } from "@cloudable/contracts";
import type { ResolvedManifestEntry } from "./manifest";
import { buildPackagesView, undeclaredFromView } from "./packages-view";

const entry = (overrides: Partial<ResolvedManifestEntry> = {}): ResolvedManifestEntry => ({
  packageName: "docker",
  versionPin: null,
  pinned: false,
  excluded: false,
  source: "org",
  resolvedFromScopeId: "org-1",
  ...overrides,
});

const rowFor = (rows: ReturnType<typeof buildPackagesView>, name: string) => {
  const row = rows.find((r) => r.packageName === name);
  if (!row) throw new Error(`no row for ${name}`);
  return row;
};

describe("buildPackagesView", () => {
  test("permission and installation are independent facts", () => {
    const rows = buildPackagesView({
      manifest: [entry({ packageName: "docker" }), entry({ packageName: "ripgrep" })],
      installedPackages: ["docker", "nmap"],
      baselinePackages: [],
    });

    // Allowed and present.
    expect(rowFor(rows, "docker")).toMatchObject({
      permission: "allowed",
      installed: "installed",
    });
    // Allowed and absent — nobody has installed it yet.
    expect(rowFor(rows, "ripgrep")).toMatchObject({
      permission: "allowed",
      installed: "not_installed",
    });
    // Present and nobody said it could be. Not "disallowed" — nobody has said
    // anything at all about it.
    expect(rowFor(rows, "nmap")).toMatchObject({ permission: null, installed: "installed" });
  });

  test("a machine that has never reported is unknown, not empty", () => {
    const rows = buildPackagesView({
      manifest: [entry()],
      installedPackages: null,
      baselinePackages: null,
    });

    // The distinction the whole column exists for: "we have not been told" is
    // not the same claim as "it is not installed".
    expect(rowFor(rows, "docker").installed).toBe("unknown");
  });

  test("an empty report is a real answer, unlike no report at all", () => {
    const rows = buildPackagesView({
      manifest: [entry()],
      installedPackages: [],
      baselinePackages: [],
    });

    expect(rowFor(rows, "docker").installed).toBe("not_installed");
  });

  test("an excluded entry reads as disallowed, and being installed anyway shows", () => {
    const rows = buildPackagesView({
      manifest: [entry({ packageName: "nmap", excluded: true, source: "machine" })],
      installedPackages: ["nmap"],
      baselinePackages: [],
    });

    expect(rowFor(rows, "nmap")).toMatchObject({
      permission: "disallowed",
      installed: "installed",
    });
  });

  test("a pinned package at the wrong version is flagged, not shown as clean", () => {
    const rows = buildPackagesView({
      manifest: [entry({ packageName: "nodejs", versionPin: "20" })],
      installedPackages: ["nodejs"],
      declaredPackageVersions: { nodejs: "18.20.4" },
      baselinePackages: [],
    });

    expect(rowFor(rows, "nodejs").versionMismatch).toBe(true);
    expect(rowFor(rows, "nodejs").installedVersion).toBe("18.20.4");
  });

  test("a matching version is not a mismatch, and an unknown version is not either", () => {
    const matching = buildPackagesView({
      manifest: [entry({ packageName: "nodejs", versionPin: "20" })],
      installedPackages: ["nodejs"],
      declaredPackageVersions: { nodejs: "20" },
      baselinePackages: [],
    });
    expect(rowFor(matching, "nodejs").versionMismatch).toBe(false);

    // Not knowing the version is not evidence of a mismatch.
    const unknownVersion = buildPackagesView({
      manifest: [entry({ packageName: "nodejs", versionPin: "20" })],
      installedPackages: ["nodejs"],
      baselinePackages: [],
    });
    expect(rowFor(unknownVersion, "nodejs").versionMismatch).toBe(false);
  });

  test("an unpinned package can never mismatch", () => {
    const rows = buildPackagesView({
      manifest: [entry({ packageName: "jq", versionPin: null })],
      installedPackages: ["jq"],
      declaredPackageVersions: { jq: "1.7" },
      baselinePackages: [],
    });

    expect(rowFor(rows, "jq").versionMismatch).toBe(false);
  });

  test("image packages are marked, so the console can keep them out of the way", () => {
    const rows = buildPackagesView({
      manifest: [],
      installedPackages: ["bash", "systemd", "nmap"],
      baselinePackages: ["bash", "systemd"],
    });

    expect(rowFor(rows, "bash").isBaseline).toBe(true);
    expect(rowFor(rows, "nmap").isBaseline).toBe(false);
  });

  test("a package with an action outstanding appears even when it is neither declared nor installed", () => {
    const pending: PendingPackageActionView = {
      id: "a1",
      op: "install",
      status: "running",
      requestedAt: new Date().toISOString(),
    };

    const rows = buildPackagesView({
      manifest: [],
      installedPackages: [],
      baselinePackages: [],
      pendingActions: new Map([["ripgrep", pending]]),
    });

    // Otherwise pressing Install on something undeclared makes the row vanish
    // until the agent reports back.
    expect(rowFor(rows, "ripgrep").pendingAction).toEqual(pending);
  });

  test("sorts what needs attention above what is merely fine", () => {
    const rows = buildPackagesView({
      manifest: [
        entry({ packageName: "docker" }),
        entry({ packageName: "nmap", excluded: true }),
        entry({ packageName: "nodejs", versionPin: "20" }),
      ],
      installedPackages: ["docker", "nmap", "nodejs", "curl", "bash"],
      declaredPackageVersions: { nodejs: "18" },
      baselinePackages: ["bash"],
    });

    expect(rows.map((r) => r.packageName)).toEqual([
      "nmap", // disallowed but installed
      "nodejs", // pinned to the wrong version
      "curl", // installed, nobody declared it
      "docker", // allowed and fine
      "bash", // came with the image
    ]);
  });
});

describe("undeclaredFromView", () => {
  test("is installed, minus the image, minus anything allowed", () => {
    const rows = buildPackagesView({
      manifest: [entry({ packageName: "docker" }), entry({ packageName: "nmap", excluded: true })],
      installedPackages: ["docker", "nmap", "curl", "bash"],
      baselinePackages: ["bash"],
    });

    // docker is allowed, bash came with the image. nmap is installed and
    // disallowed; curl is installed and unclaimed. Both are undeclared.
    expect(undeclaredFromView(rows).sort()).toEqual(["curl", "nmap"]);
  });

  test("a machine that has never reported has no undeclared software", () => {
    const rows = buildPackagesView({
      manifest: [entry()],
      installedPackages: null,
      baselinePackages: null,
    });

    // Silence is not evidence. A machine that has gone quiet is the reporting
    // check's problem, not this one's.
    expect(undeclaredFromView(rows)).toEqual([]);
  });

  test("the whole base image is not several hundred findings", () => {
    const image = Array.from({ length: 600 }, (_, i) => `base-pkg-${i}`);
    const rows = buildPackagesView({
      manifest: [],
      installedPackages: [...image, "nmap"],
      baselinePackages: image,
    });

    expect(undeclaredFromView(rows)).toEqual(["nmap"]);
  });
});

describe("baseline capture", () => {
  test("a machine whose baseline was never captured shows the whole image as undeclared", () => {
    // The shape of the bug this guards. `recordReportedPackages` used to take a
    // `captureBaseline` flag derived from `lastVerifiedAt`, which `create()`
    // already sets the moment a provider returns "running" — true for docker,
    // false for azure, which returns "provisioning". So the baseline silently
    // never captured on docker machines and did on azure ones, and nothing
    // said so: the table just showed every one of the image's packages as
    // undeclared software installed by nobody.
    const image = ["bash", "systemd", "coreutils"];

    const withoutBaseline = buildPackagesView({
      manifest: [],
      installedPackages: [...image, "nmap"],
      baselinePackages: null,
    });
    expect(undeclaredFromView(withoutBaseline).sort()).toEqual([
      "bash",
      "coreutils",
      "nmap",
      "systemd",
    ]);

    const withBaseline = buildPackagesView({
      manifest: [],
      installedPackages: [...image, "nmap"],
      baselinePackages: image,
    });
    expect(undeclaredFromView(withBaseline)).toEqual(["nmap"]);
  });
});
