import { describe, expect, test } from "bun:test";
import {
  type MachinePackageRow,
  computeUndeclaredPackages,
  declaredPackages,
  findEnsureSettingProblems,
  findLockConflicts,
  packageNameFromSettingKey,
  packageSettingKey,
  resolveManifest,
} from "./manifest";

const chain = { orgId: "org-1", profileId: null, machineId: "machine-1" };

describe("resolveManifest", () => {
  test("machine-level entry overrides an org-level entry for the same package", () => {
    const rows: MachinePackageRow[] = [
      {
        scopeType: "org",
        scopeId: "org-1",
        packageName: "docker",
        versionPin: null,
        locked: false,
        excluded: false,
        source: "org",
      },
      {
        scopeType: "machine",
        scopeId: "machine-1",
        packageName: "docker",
        versionPin: "24",
        locked: false,
        excluded: false,
        source: "machine",
      },
    ];

    const manifest = resolveManifest(rows, chain);

    expect(manifest).toEqual([
      {
        packageName: "docker",
        versionPin: "24",
        locked: false,
        excluded: false,
        source: "machine",
        resolvedFromScopeId: "machine-1",
        partOf: null,
        description: null,
        setting: "allowed",
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
        locked: false,
        excluded: false,
        source: "org",
      },
      {
        scopeType: "machine",
        scopeId: "machine-1",
        packageName: "nodejs",
        versionPin: "20",
        locked: false,
        excluded: false,
        source: "machine",
      },
      // A different machine's row must never leak into this machine's resolution.
      {
        scopeType: "machine",
        scopeId: "machine-2",
        packageName: "python",
        versionPin: null,
        locked: false,
        excluded: false,
        source: "machine",
      },
    ];

    const manifest = resolveManifest(rows, chain);

    expect(manifest).toEqual([
      {
        packageName: "docker",
        versionPin: null,
        locked: false,
        excluded: false,
        source: "org",
        resolvedFromScopeId: "org-1",
        partOf: null,
        description: null,
        setting: "allowed",
      },
      {
        packageName: "nodejs",
        versionPin: "20",
        locked: false,
        excluded: false,
        source: "machine",
        resolvedFromScopeId: "machine-1",
        partOf: null,
        description: null,
        setting: "allowed",
      },
    ]);
  });

  test("empty rows resolve to an empty manifest", () => {
    expect(resolveManifest([], chain)).toEqual([]);
  });
});

describe("findLockConflicts", () => {
  test("a base profile's lock binds the profile that extends it, and the closest lock is reported", () => {
    const row = (scopeId: string, locked: boolean): MachinePackageRow => ({
      scopeType: "profile",
      scopeId,
      packageName: "jq",
      versionPin: null,
      locked,
      excluded: false,
      source: "profile",
    });
    const baseLocked = [row("base-1", true)];
    expect(findLockConflicts(baseLocked, "profile", ["jq"], "base-1")).toEqual([
      {
        packageName: "jq",
        lockedAtScope: "profile",
        lockedAtScopeId: "base-1",
        lockedVersionPin: null,
      },
    ]);
    // Without knowing which row is the base, a profile row never binds a profile edit.
    expect(findLockConflicts(baseLocked, "profile", ["jq"])).toEqual([]);
    // Both lock: a machine edit collides with its own profile's lock first.
    const both = [row("base-1", true), row("child-1", true)];
    expect(findLockConflicts(both, "machine", ["jq"], "base-1")[0]?.lockedAtScopeId).toBe(
      "child-1",
    );
  });

  test("an org-locked entry blocks a machine-level override of the same package", () => {
    const rows: MachinePackageRow[] = [
      {
        scopeType: "org",
        scopeId: "org-1",
        packageName: "docker",
        versionPin: "24",
        locked: true,
        excluded: false,
        source: "org",
      },
    ];

    const conflicts = findLockConflicts(rows, "machine", ["docker"]);

    expect(conflicts).toEqual([
      {
        packageName: "docker",
        lockedAtScope: "org",
        lockedAtScopeId: "org-1",
        lockedVersionPin: "24",
      },
    ]);
  });

  test("an unlocked org entry does not block a machine-level override", () => {
    const rows: MachinePackageRow[] = [
      {
        scopeType: "org",
        scopeId: "org-1",
        packageName: "docker",
        versionPin: null,
        locked: false,
        excluded: false,
        source: "org",
      },
    ];

    expect(findLockConflicts(rows, "machine", ["docker"])).toEqual([]);
  });

  test("a machine locking its own entry is not an override-below and reports no conflict", () => {
    const rows: MachinePackageRow[] = [
      {
        scopeType: "machine",
        scopeId: "machine-1",
        packageName: "docker",
        versionPin: "24",
        locked: true,
        excluded: false,
        source: "machine",
      },
    ];

    expect(findLockConflicts(rows, "machine", ["docker"])).toEqual([]);
  });

  test("only edited package names that are actually locked above are reported", () => {
    const rows: MachinePackageRow[] = [
      {
        scopeType: "org",
        scopeId: "org-1",
        packageName: "docker",
        versionPin: null,
        locked: true,
        excluded: false,
        source: "org",
      },
      {
        scopeType: "org",
        scopeId: "org-1",
        packageName: "nodejs",
        versionPin: null,
        locked: false,
        excluded: false,
        source: "org",
      },
    ];

    expect(findLockConflicts(rows, "machine", ["docker", "nodejs"])).toEqual([
      {
        packageName: "docker",
        lockedAtScope: "org",
        lockedAtScopeId: "org-1",
        lockedVersionPin: null,
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
    locked: false,
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
        locked: false,
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
          locked: false,
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
          locked: false,
          excluded: true,
          source: "machine",
        },
      ],
      chain,
    );

    expect(declaredPackages(manifest).map((entry) => entry.packageName)).toEqual(["docker"]);
  });

  test("an org lock blocks a machine trying to exclude that package", () => {
    const rows: MachinePackageRow[] = [{ ...orgDocker, locked: true }];

    // Exclusion is an override like any other, so it goes through the same
    // edit-time lock check rather than needing one of its own.
    expect(findLockConflicts(rows, "machine", ["docker"])).toEqual([
      {
        packageName: "docker",
        lockedAtScope: "org",
        lockedAtScopeId: "org-1",
        lockedVersionPin: "24",
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

describe("findEnsureSettingProblems", () => {
  test("Allowed is always fine, and an apt package can be ensured with or without a pin", () => {
    expect(
      findEnsureSettingProblems([
        { packageName: "npm:@openai/codex", setting: "allowed", versionPin: null },
        { packageName: "ripgrep", setting: "ensure_installed", versionPin: "14.1.0" },
        { packageName: "jq", setting: "ensure_latest", versionPin: null },
      ]),
    ).toEqual([]);
  });

  test("refuses a package Cloudable cannot install, and Ensure latest version with a pin", () => {
    expect(
      findEnsureSettingProblems([
        { packageName: "home:chromium", setting: "ensure_installed", versionPin: null },
        { packageName: "nodejs", setting: "ensure_latest", versionPin: "20" },
      ]).map((problem) => [problem.packageName, problem.reason]),
    ).toEqual([
      ["home:chromium", "not_installable"],
      ["nodejs", "ensure_latest_with_pin"],
    ]);
  });
});
