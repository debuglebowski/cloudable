import { describe, expect, test } from "bun:test";
import { resolveSetting, type SettingRow } from "./resolve-setting";

const rows: ReadonlyArray<SettingRow<string>> = [
  { scopeType: "org", scopeId: "org-1", key: "region", value: "eu-west", source: "org" },
  { scopeType: "machine", scopeId: "machine-1", key: "region", value: "us-east", source: "machine" },
  { scopeType: "template", scopeId: "template-1", key: "size", value: "small", source: "template" },
];

describe("resolveSetting", () => {
  test("machine override wins over org and template", () => {
    const resolved = resolveSetting("region", rows, {
      orgId: "org-1",
      templateId: "template-1",
      machineId: "machine-1",
    });

    expect(resolved).toEqual({
      key: "region",
      value: "us-east",
      source: "machine",
      resolvedFromScopeId: "machine-1",
    });
  });

  test("falls back to org when no machine or template row matches", () => {
    const resolved = resolveSetting("region", rows, {
      orgId: "org-1",
      templateId: "template-1",
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
      templateId: "template-1",
      machineId: "machine-1",
    });

    expect(resolved).toBeUndefined();
  });
});
