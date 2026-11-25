import { describe, expect, test } from "bun:test";
import { type SettingRow, resolveSetting } from "./resolve-setting";

const rows: ReadonlyArray<SettingRow<string>> = [
  { scopeType: "org", scopeId: "org-1", key: "region", value: "eu-west", source: "org" },
  {
    scopeType: "machine",
    scopeId: "machine-1",
    key: "region",
    value: "us-east",
    source: "machine",
  },
  { scopeType: "profile", scopeId: "profile-1", key: "size", value: "small", source: "profile" },
];

describe("resolveSetting", () => {
  test("machine override wins over org and profile", () => {
    const resolved = resolveSetting("region", rows, {
      orgId: "org-1",
      profileId: "profile-1",
      machineId: "machine-1",
    });

    expect(resolved).toEqual({
      key: "region",
      value: "us-east",
      source: "machine",
      resolvedFromScopeId: "machine-1",
    });
  });

  test("falls back to org when no machine or profile row matches", () => {
    const resolved = resolveSetting("region", rows, {
      orgId: "org-1",
      profileId: "profile-1",
      machineId: "machine-2",
    });

    expect(resolved).toEqual({
      key: "region",
      value: "eu-west",
      source: "org",
      resolvedFromScopeId: "org-1",
    });
  });

  test("returns undefined when nothing matches", () => {
    const resolved = resolveSetting("does-not-exist", rows, {
      orgId: "org-1",
      profileId: "profile-1",
      machineId: "machine-1",
    });

    expect(resolved).toBeUndefined();
  });

  test("a profile's own row wins over its base's, and the base's over the org's", () => {
    const chained: ReadonlyArray<SettingRow<string>> = [
      { scopeType: "org", scopeId: "org-1", key: "tier", value: "org", source: "org" },
      { scopeType: "profile", scopeId: "base-1", key: "tier", value: "base", source: "profile" },
      { scopeType: "profile", scopeId: "base-1", key: "size", value: "big", source: "profile" },
      { scopeType: "profile", scopeId: "child-1", key: "tier", value: "child", source: "profile" },
    ];
    const chain = {
      orgId: "org-1",
      profileId: "child-1",
      baseProfileId: "base-1",
      machineId: "machine-1",
    };
    expect(resolveSetting("tier", chained, chain)?.resolvedFromScopeId).toBe("child-1");
    expect(resolveSetting("size", chained, chain)).toMatchObject({
      value: "big",
      resolvedFromScopeId: "base-1",
    });
    // Without the base in the chain, its rows are not read.
    expect(resolveSetting("size", chained, { ...chain, baseProfileId: null })).toBeUndefined();
  });
});
