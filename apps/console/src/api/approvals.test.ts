import { describe, expect, test } from "bun:test";

import { decisionBlockedReason, describePayload } from "./approvals";

const me = { personId: "me", approver: true, isAdmin: false };
const request = {
  actionType: "package_install" as const,
  requestedByPersonId: "someone",
  targetPersonId: null,
  targetMachineOwnerId: "someone",
};

describe("decisionBlockedReason", () => {
  test("an approver may decide someone else's request", () => {
    expect(decisionBlockedReason(request, me)).toBeNull();
  });

  test("nobody decides their own request, one about themselves, or about their machine", () => {
    expect(decisionBlockedReason({ ...request, requestedByPersonId: "me" }, me)).not.toBeNull();
    expect(decisionBlockedReason({ ...request, targetPersonId: "me" }, me)).not.toBeNull();
    expect(decisionBlockedReason({ ...request, targetMachineOwnerId: "me" }, me)).not.toBeNull();
  });

  test("a member who is not an approver decides nothing", () => {
    expect(decisionBlockedReason(request, { ...me, approver: false })).not.toBeNull();
  });

  test("an admin who is not an approver cannot sign off approval settings", () => {
    const admin = { personId: "me", approver: false, isAdmin: true };
    expect(decisionBlockedReason(request, admin)).toBeNull();
    expect(
      decisionBlockedReason({ ...request, actionType: "approval_settings_change" }, admin),
    ).not.toBeNull();
  });
});

describe("describePayload", () => {
  test("says which package and version", () => {
    expect(
      describePayload("package_install", {
        packageName: "htop",
        op: "install",
        versionPin: "3.3",
        isBaselinePackage: false,
      }),
    ).toBe("Install htop (version 3.3)");
  });

  test("lists the requested approval modes", () => {
    expect(
      describePayload("approval_settings_change", { approvalModes: { package_install: "dual" } }),
    ).toBe("Package install: two approvers");
  });

  test("nothing for action types whose target says it all", () => {
    expect(describePayload("offboarding", null)).toBeNull();
  });
});
