import { describe, expect, it } from "bun:test";
import { decideCloudableRole, grantsOf } from "./precedence";

describe("decideCloudableRole", () => {
  it("takes the highest role and adds the approver flag", () => {
    expect(decideCloudableRole(["admin", "approver", "member"])).toEqual({
      kind: "granted",
      role: "admin",
      approver: true,
    });
    expect(decideCloudableRole(["member", "owner"])).toEqual({
      kind: "granted",
      role: "owner",
      approver: false,
    });
  });

  it("denies when only the approver flag is mapped, or nothing", () => {
    expect(decideCloudableRole(["approver"])).toEqual({ kind: "denied" });
    expect(decideCloudableRole([])).toEqual({ kind: "denied" });
  });
});

describe("grantsOf", () => {
  it("lists the stored role and the flag, sorted", () => {
    expect(grantsOf({ role: "member", approver: true })).toEqual(["approver", "member"]);
    expect(grantsOf({ role: "owner", approver: false })).toEqual(["owner"]);
  });
});
