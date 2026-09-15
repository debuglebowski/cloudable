import { describe, expect, test } from "bun:test";
import {
  type MachinePackageRow,
  computeUndeclaredPackages,
  declaredPackages,
  findPinConflicts,
  packageNameFromSettingKey,
  packageSettingKey,
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
        excluded: false,
        source: "org",
      },
      {
        scopeType: "machine",
        scopeId: "machine-1",
        packageName: "docker",
        versionPin: "24",
        pinned: false,
        excluded: false,
        source: "machine",
      },
    ];

    const manifest = resolveManifest(rows, chain);

    expect(manifest).toEqual([
      {
        packageName: "docker",
        versionPin: "24",
        pinned: false,
        excluded: false,
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
        excluded: false,
        source: "org",
      },
      {
        scopeType: "machine",
        scopeId: "machine-1",
        packageName: "nodejs",
        versionPin: "20",
        pinned: false,
        excluded: false,
        source: "machine",
      },
      // A different machine's row must never leak into this machine's resolution.
      {
        scopeType: "machine",
        scopeId: "machine-2",
        packageName: "python",
        versionPin: null,
        pinned: false,
        excluded: false,
        source: "machine",
      },
    ];

    const manifest = resolveManifest(rows, chain);

    expect(manifest).toEqual([
      {
        packageName: "docker",
        versionPin: null,
        pinned: false,
        excluded: false,
        source: "org",
        resolvedFromScopeId: "org-1",
      },
      {
        packageName: "nodejs",
        versionPin: "20",
        pinned: false,
        excluded: false,
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
        excluded: false,
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
        excluded: false,
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
        excluded: false,
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
        excluded: false,
        source: "org",
      },
      {
        scopeType: "org",
        scopeId: "org-1",
        packageName: "nodejs",
        versionPin: null,
        pinned: false,
        excluded: false,
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
    const manifest = [
      { packageName: "docker", excluded: false },
      { packageName: "nodejs", excluded: false },
    ];

    expect(computeUndeclaredPackages(manifest, ["docker", "curl", "nodejs", "vim"])).toEqual([
      "curl",
      "vim",
    ]);
  });

  test("dedupes repeated undeclared names and never mutates order among the reported list", () => {
    const manifest: Array<{ packageName: string; excluded: boolean }> = [];

    expect(computeUndeclaredPackages(manifest, ["curl", "vim", "curl"])).toEqual(["curl", "vim"]);
  });

  test("returns an empty list when nothing is undeclared", () => {
    const manifest = [{ packageName: "docker", excluded: false }];

    expect(computeUndeclaredPackages(manifest, ["docker"])).toEqual([]);
  });
});

describe("exclusion", () => {
  const orgDocker: MachinePackageRow = {
    scopeType: "org",
    scopeId: "org-1",
    packageName: "docker",
    versionPin: "24",
    pinned: false,
    excluded: false,
    source: "org",
  };

  test("a machine-level exclusion wins over the org's entry", () => {
    const rows: MachinePackageRow[] = [
      orgDocker,
      {
        scopeType: "machine",
        scopeId: "machine-1",
        packageName: "docker",
        versionPin: null,
        pinned: false,
        excluded: true,
        source: "machine",
      },
    ];

    const manifest = resolveManifest(rows, chain);

    // Still resolved, so the console can render it and offer to undo — but no
    // longer declared.
    expect(manifest).toHaveLength(1);
    expect(manifest[0]?.excluded).toBe(true);
    expect(manifest[0]?.source).toBe("machine");
    expect(declaredPackages(manifest)).toEqual([]);
  });

  test("an excluded package that is installed anyway reads as undeclared", () => {
    const manifest = resolveManifest(
      [
        orgDocker,
        {
          scopeType: "machine",
          scopeId: "machine-1",
          packageName: "docker",
          versionPin: null,
          pinned: false,
          excluded: true,
          source: "machine",
        },
      ],
      chain,
    );

    expect(computeUndeclaredPackages(manifest, ["docker"])).toEqual(["docker"]);
  });

  test("another machine's exclusion never reaches this machine", () => {
    const manifest = resolveManifest(
      [
        orgDocker,
        {
          scopeType: "machine",
          scopeId: "machine-2",
          packageName: "docker",
          versionPin: null,
          pinned: false,
          excluded: true,
          source: "machine",
        },
      ],
      chain,
    );

    expect(declaredPackages(manifest).map((entry) => entry.packageName)).toEqual(["docker"]);
  });

  test("an org pin blocks a machine trying to exclude that package", () => {
    const rows: MachinePackageRow[] = [{ ...orgDocker, pinned: true }];

    // Exclusion is an override like any other, so it goes through the same
    // edit-time pin check rather than needing one of its own.
    expect(findPinConflicts(rows, "machine", ["docker"])).toEqual([
      {
        packageName: "docker",
        pinnedAtScope: "org",
        pinnedAtScopeId: "org-1",
        pinnedVersionPin: "24",
      },
    ]);
  });
});

describe("package setting keys", () => {
  test("round-trips a package name, and rejects a non-package key", () => {
    expect(packageSettingKey("docker")).toBe("package:docker");
    expect(packageNameFromSettingKey("package:docker")).toBe("docker");
    // A real setting key must never be mistaken for a manifest edit — this is
    // what keeps the tier-filter carve-out and the history query honest.
    expect(packageNameFromSettingKey("logging_tier")).toBeNull();
  });

  test("keeps a scoped name intact, colons and all", () => {
    expect(packageNameFromSettingKey(packageSettingKey("@scope/pkg"))).toBe("@scope/pkg");
  });
});
