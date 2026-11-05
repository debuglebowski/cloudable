import { describe, expect, test } from "bun:test";

import { canSeePage } from "./role";

const member = { personId: "m", role: "member", approver: false };
const approver = { personId: "a", role: "member", approver: true };
const admin = { personId: "o", role: "owner", approver: false };

describe("canSeePage", () => {
  test("admin pages are admins only", () => {
    expect(canSeePage(member, "admin")).toBe(false);
    expect(canSeePage(approver, "admin")).toBe(false);
    expect(canSeePage(admin, "admin")).toBe(true);
  });

  test("the Approvals page is approvers and admins", () => {
    expect(canSeePage(member, "approver")).toBe(false);
    expect(canSeePage(approver, "approver")).toBe(true);
    expect(canSeePage(admin, "approver")).toBe(true);
  });
});
