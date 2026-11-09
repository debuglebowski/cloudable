import { describe, expect, it } from "bun:test";
import { fingerprintOf, readIdpRolesConfig } from "./config";

const CLAIM = "http://schemas.microsoft.com/ws/2008/06/identity/claims/role";
const ON = {
  IDP_ROLES_ENABLED: "true",
  IDP_ROLE_CLAIM: CLAIM,
  IDP_ROLE_MAPPING: JSON.stringify({
    "Cloudable.Admin": ["admin"],
    "Cloudable.Member": ["member"],
    "Cloudable.Approver": ["approver"],
  }),
};

const refused = (env: Record<string, string | undefined>, idpConfigured = true) => {
  try {
    readIdpRolesConfig(env, idpConfigured);
    return undefined;
  } catch (error) {
    return error as { code?: string; message: string };
  }
};

describe("readIdpRolesConfig (shared parseConfig + Cloudable's startup rules)", () => {
  it("is off by default and when explicitly off", () => {
    expect(readIdpRolesConfig({}, false)).toBeNull();
    expect(readIdpRolesConfig({ IDP_ROLES_ENABLED: "false" }, false)).toBeNull();
  });

  it("reads the canonical keys, with a one-hour default interval", () => {
    const parsed = readIdpRolesConfig(ON, true);
    expect(parsed).toMatchObject({
      enabled: true,
      claim: CLAIM,
      intervalSec: 3600,
      mapping: { "Cloudable.Admin": ["admin"], "Cloudable.Approver": ["approver"] },
    });
    expect(parsed?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(
      readIdpRolesConfig({ ...ON, IDP_RECHECK_INTERVAL_SECONDS: "900" }, true)?.intervalSec,
    ).toBe(900);
  });

  it("refuses to start rather than half-enable", () => {
    for (const env of [
      { ...ON, IDP_ROLES_ENABLED: "on" },
      { ...ON, IDP_ROLE_CLAIM: "" },
      { ...ON, IDP_ROLE_MAPPING: '{"Cloudable.Admin":"admin"}' },
      { ...ON, IDP_ROLE_MAPPING: '{"Cloudable.Admin":["superuser"]}' },
      { ...ON, IDP_ROLE_MAPPING: "{}" },
      { ...ON, IDP_RECHECK_INTERVAL_SECONDS: "3601" },
      // Names this branch and the old Cloudable mode used. Refused even next to the new ones.
      { ...ON, ROLES_FROM_IDP: "on" },
      { ...ON, IDP_ROLE_UNMAPPED: "deny" },
    ]) {
      expect(refused(env)?.code).toBe("INVALID_IDP_ROLE_CONFIG");
    }
  });

  it("needs the identity provider declared in deployment config", () => {
    expect(refused(ON, false)?.message).toContain("IDP_SAML_CONFIG");
  });

  it("cannot be combined with password sign-in", () => {
    expect(refused({ ...ON, PASSWORD_SIGN_IN: "on" })?.message).toContain("PASSWORD_SIGN_IN");
  });

  it("fingerprints the claim and mapping, not their order", () => {
    const a = fingerprintOf({
      claim: "roles",
      mapping: { A: ["admin", "approver"], B: ["member"] },
    });
    const b = fingerprintOf({
      claim: "roles",
      mapping: { B: ["member"], A: ["approver", "admin"] },
    });
    const c = fingerprintOf({ claim: "roles", mapping: { A: ["admin"], B: ["member"] } });
    const d = fingerprintOf({
      claim: "groups",
      mapping: { B: ["member"], A: ["approver", "admin"] },
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });
});
