import { describe, expect, test } from "bun:test";
import type { SettingRow } from "@cloudable/schema";
import {
  ADMIN_ACCESS_APPROVAL_MODE_SETTING_KEY,
  ADMIN_ACCESS_ELEVATION_TTL_MINUTES_SETTING_KEY,
  ADMIN_ACCESS_POLICY_SETTING_KEY,
  DEFAULT_ADMIN_ACCESS_POLICY,
  DEFAULT_APPROVAL_MODE,
  DEFAULT_ELEVATION_TTL_MINUTES,
  approvalModeSatisfiesFloor,
  requiredApprovalModeFloor,
  resolveAdminAccessApprovalMode,
  resolveAdminAccessPolicy,
  resolveElevationTtlMinutes,
} from "./policy";

const chain = { orgId: "org-1", templateId: null, machineId: "machine-1" };

describe("requiredApprovalModeFloor", () => {
  test("file_recovery floors at single", () => {
    expect(requiredApprovalModeFloor("file_recovery")).toBe("single");
  });

  test("shell floors at dual — it can read live injected secrets", () => {
    expect(requiredApprovalModeFloor("shell")).toBe("dual");
  });
});

describe("approvalModeSatisfiesFloor", () => {
  test("none does not satisfy single or dual", () => {
    expect(approvalModeSatisfiesFloor("none", "single")).toBe(false);
    expect(approvalModeSatisfiesFloor("none", "dual")).toBe(false);
  });

  test("single satisfies single but not dual", () => {
    expect(approvalModeSatisfiesFloor("single", "single")).toBe(true);
    expect(approvalModeSatisfiesFloor("single", "dual")).toBe(false);
  });

  test("dual satisfies everything", () => {
    expect(approvalModeSatisfiesFloor("dual", "single")).toBe(true);
    expect(approvalModeSatisfiesFloor("dual", "dual")).toBe(true);
  });
});

describe("resolveAdminAccessPolicy", () => {
  test("defaults to with_approval (fail-safe) when unset", () => {
    expect(resolveAdminAccessPolicy([], chain)).toBe(DEFAULT_ADMIN_ACCESS_POLICY);
    expect(DEFAULT_ADMIN_ACCESS_POLICY).toBe("with_approval");
  });

  test("reads the org-scoped admin_access_policy setting", () => {
    const rows: SettingRow<unknown>[] = [
      {
        scopeType: "org",
        scopeId: "org-1",
        key: ADMIN_ACCESS_POLICY_SETTING_KEY,
        value: "never",
        source: "org",
      },
    ];
    expect(resolveAdminAccessPolicy(rows, chain)).toBe("never");
  });

  test("a machine-scoped override wins over the org default", () => {
    const rows: SettingRow<unknown>[] = [
      {
        scopeType: "org",
        scopeId: "org-1",
        key: ADMIN_ACCESS_POLICY_SETTING_KEY,
        value: "never",
        source: "org",
      },
      {
        scopeType: "machine",
        scopeId: "machine-1",
        key: ADMIN_ACCESS_POLICY_SETTING_KEY,
        value: "always",
        source: "machine",
      },
    ];
    expect(resolveAdminAccessPolicy(rows, chain)).toBe("always");
  });
});

describe("resolveAdminAccessApprovalMode", () => {
  test("defaults to single when unset", () => {
    expect(resolveAdminAccessApprovalMode([], chain)).toBe(DEFAULT_APPROVAL_MODE);
    expect(DEFAULT_APPROVAL_MODE).toBe("single");
  });

  test("reads the configured mode", () => {
    const rows: SettingRow<unknown>[] = [
      {
        scopeType: "org",
        scopeId: "org-1",
        key: ADMIN_ACCESS_APPROVAL_MODE_SETTING_KEY,
        value: "dual",
        source: "org",
      },
    ];
    expect(resolveAdminAccessApprovalMode(rows, chain)).toBe("dual");
  });
});

describe("resolveElevationTtlMinutes", () => {
  test("defaults to 60 minutes when unset", () => {
    expect(resolveElevationTtlMinutes([], chain)).toBe(DEFAULT_ELEVATION_TTL_MINUTES);
    expect(DEFAULT_ELEVATION_TTL_MINUTES).toBe(60);
  });

  test("reads the configured ttl", () => {
    const rows: SettingRow<unknown>[] = [
      {
        scopeType: "org",
        scopeId: "org-1",
        key: ADMIN_ACCESS_ELEVATION_TTL_MINUTES_SETTING_KEY,
        value: 15,
        source: "org",
      },
    ];
    expect(resolveElevationTtlMinutes(rows, chain)).toBe(15);
  });
});
