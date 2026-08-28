import { describe, expect, test } from "bun:test";
import {
  type MachinePackageRow,
  computeUndeclaredPackages,
  findPinConflicts,
  resolveManifest,
} from "./manifest";

const chain = { orgId: "org-1", templateId: null, machineId: "machine-1" };

describe("resolveManifest", () => {
  test("machine-level entry overrides an org-level entry for the same package", () => {
    const rows: MachinePackageRow[] = [
      {
        scopeType: "org",
        scopeId: "org-1",
        packageName: "docker",
        versionPin: null,
        pinned: false,
        source: "org",
      },
      {
        scopeType: "machine",
        scopeId: "machine-1",
        packageName: "docker",
        versionPin: "24",
        pinned: false,
        source: "machine",
      },
    ];

    const manifest = resolveManifest(rows, chain);

    expect(manifest).toEqual([
      {
        packageName: "docker",
        versionPin: "24",
        pinned: false,
        source: "machine",
        resolvedFromScopeId: "machine-1",
      },
    ]);
  });

  test("falls back to the org entry when no machine override exists, and unions distinct package names", () => {
    const rows: MachinePackageRow[] = [
      {
        scopeType: "org",
        scopeId: "org-1",
        packageName: "docker",
        versionPin: null,
        pinned: false,
        source: "org",
      },
      {
        scopeType: "machine",
        scopeId: "machine-1",
        packageName: "nodejs",
        versionPin: "20",
        pinned: false,
        source: "machine",
      },
      // A different machine's row must never leak into this machine's resolution.
      {
        scopeType: "machine",
        scopeId: "machine-2",
        packageName: "python",
        versionPin: null,
        pinned: false,
        source: "machine",
      },
    ];

    const manifest = resolveManifest(rows, chain);

    expect(manifest).toEqual([
      {
        packageName: "docker",
        versionPin: null,
        pinned: false,
        source: "org",
        resolvedFromScopeId: "org-1",
      },
      {
        packageName: "nodejs",
        versionPin: "20",
        pinned: false,
        source: "machine",
        resolvedFromScopeId: "machine-1",
      },
    ]);
  });

  test("empty rows resolve to an empty manifest", () => {
    expect(resolveManifest([], chain)).toEqual([]);
  });
});

describe("findPinConflicts", () => {
  test("an org-pinned entry blocks a machine-level override of the same package", () => {
    const rows: MachinePackageRow[] = [
      {
        scopeType: "org",
        scopeId: "org-1",
        packageName: "docker",
        versionPin: "24",
        pinned: true,
        source: "org",
      },
    ];

    const conflicts = findPinConflicts(rows, "machine", ["docker"]);

    expect(conflicts).toEqual([
      {
        packageName: "docker",
        pinnedAtScope: "org",
        pinnedAtScopeId: "org-1",
        pinnedVersionPin: "24",
      },
    ]);
  });

  test("an unpinned org entry does not block a machine-level override", () => {
    const rows: MachinePackageRow[] = [
      {
        scopeType: "org",
        scopeId: "org-1",
        packageName: "docker",
        versionPin: null,
        pinned: false,
        source: "org",
      },
    ];

    expect(findPinConflicts(rows, "machine", ["docker"])).toEqual([]);
  });

  test("a machine pinning its own entry is not an override-below and reports no conflict", () => {
    const rows: MachinePackageRow[] = [
      {
        scopeType: "machine",
        scopeId: "machine-1",
        packageName: "docker",
        versionPin: "24",
        pinned: true,
        source: "machine",
      },
    ];

    expect(findPinConflicts(rows, "machine", ["docker"])).toEqual([]);
  });

  test("only edited package names that are actually pinned above are reported", () => {
    const rows: MachinePackageRow[] = [
      {
        scopeType: "org",
        scopeId: "org-1",
        packageName: "docker",
        versionPin: null,
        pinned: true,
        source: "org",
      },
      {
        scopeType: "org",
        scopeId: "org-1",
        packageName: "nodejs",
        versionPin: null,
        pinned: false,
        source: "org",
      },
    ];

    expect(findPinConflicts(rows, "machine", ["docker", "nodejs"])).toEqual([
      {
        packageName: "docker",
        pinnedAtScope: "org",
        pinnedAtScopeId: "org-1",
        pinnedVersionPin: null,
      },
    ]);
  });
});

describe("computeUndeclaredPackages", () => {
  test("returns reported packages absent from the resolved manifest", () => {
    const manifest = [{ packageName: "docker" }, { packageName: "nodejs" }];

    expect(computeUndeclaredPackages(manifest, ["docker", "curl", "nodejs", "vim"])).toEqual([
      "curl",
      "vim",
    ]);
  });

  test("dedupes repeated undeclared names and never mutates order among the reported list", () => {
    const manifest: Array<{ packageName: string }> = [];

    expect(computeUndeclaredPackages(manifest, ["curl", "vim", "curl"])).toEqual(["curl", "vim"]);
  });

  test("returns an empty list when nothing is undeclared", () => {
    const manifest = [{ packageName: "docker" }];

    expect(computeUndeclaredPackages(manifest, ["docker"])).toEqual([]);
  });
});
