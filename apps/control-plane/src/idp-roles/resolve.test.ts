import { describe, expect, it } from "bun:test";
import type { IdpRolesConfig } from "./config";
import { claimValues, resolveIdpRole } from "./resolve";

const config: IdpRolesConfig = {
  claim: "roles",
  mapping: {
    "Cloudable.Owner": "owner",
    "Cloudable.Admin": "admin",
    "Cloudable.Member": "member",
    "Cloudable.Approver": "approver",
  },
  unmapped: "deny",
};

describe("claimValues", () => {
  it("reads one value, several values, or none", () => {
    expect(claimValues("Cloudable.Admin")).toEqual(["Cloudable.Admin"]);
    expect(claimValues(["a", "b"])).toEqual(["a", "b"]);
    expect(claimValues(["a", 3, "", null])).toEqual(["a"]);
    expect(claimValues(undefined)).toEqual([]);
    expect(claimValues("")).toEqual([]);
    expect(claimValues({ a: 1 })).toEqual([]);
  });
});

describe("resolveIdpRole", () => {
  it("maps a value to its role", () => {
    expect(resolveIdpRole(["Cloudable.Admin"], config)).toEqual({
      kind: "granted",
      role: "admin",
      approver: false,
      matched: ["Cloudable.Admin"],
    });
  });

  it("picks the highest of several roles and sets the approver flag", () => {
    expect(
      resolveIdpRole(["Cloudable.Member", "Cloudable.Approver", "Cloudable.Owner"], config),
    ).toMatchObject({ kind: "granted", role: "owner", approver: true });
  });

  it("ignores values it does not know, and matches exactly", () => {
    expect(resolveIdpRole(["Other.App", "Cloudable.Member"], config)).toMatchObject({
      kind: "granted",
      role: "member",
      matched: ["Cloudable.Member"],
    });
    expect(resolveIdpRole(["cloudable.admin"], config).kind).toBe("denied");
    expect(resolveIdpRole(["toString", "__proto__"], config).kind).toBe("denied");
  });

  it("denies with no mapped role, even with the approver flag", () => {
    expect(resolveIdpRole([], config)).toEqual({ kind: "denied", values: [] });
    expect(resolveIdpRole(["Cloudable.Approver"], config).kind).toBe("denied");
  });

  it("lets an unmapped person in as a member when the operator chose that", () => {
    const lenient = { ...config, unmapped: "member" as const };
    expect(resolveIdpRole([], lenient)).toEqual({
      kind: "granted",
      role: "member",
      approver: false,
      matched: [],
    });
    expect(resolveIdpRole(["Cloudable.Approver"], lenient)).toMatchObject({
      role: "member",
      approver: true,
    });
  });
});
