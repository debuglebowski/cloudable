import { describe, expect, it } from "bun:test";
import { type IdpTrust, fingerprintOf, readIdpRolesConfig } from "./config";

const IDP: IdpTrust = {
  providerId: "configured",
  entityId: "https://sts.windows.net/tenant/",
  ssoUrl: "https://login.microsoftonline.com/tenant/saml2",
  emailDomains: "example.com",
  certs: ["MIIC-cert-a"],
};

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

const refused = (env: Record<string, string | undefined>, idp: IdpTrust | null = IDP) => {
  try {
    readIdpRolesConfig(env, idp);
    return undefined;
  } catch (error) {
    return error as { code?: string; message: string };
  }
};

describe("readIdpRolesConfig (shared parseConfig + Cloudable's startup rules)", () => {
  it("is off by default and when explicitly off", () => {
    expect(readIdpRolesConfig({}, null)).toBeNull();
    expect(readIdpRolesConfig({ IDP_ROLES_ENABLED: "false" }, null)).toBeNull();
  });

  it("reads the canonical keys, with a one-hour default interval", () => {
    const parsed = readIdpRolesConfig(ON, IDP);
    expect(parsed).toMatchObject({
      enabled: true,
      claim: CLAIM,
      intervalSec: 3600,
      mapping: { "Cloudable.Admin": ["admin"], "Cloudable.Approver": ["approver"] },
    });
    expect(parsed?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(
      readIdpRolesConfig({ ...ON, IDP_RECHECK_INTERVAL_SECONDS: "900" }, IDP)?.intervalSec,
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
    expect(refused(ON, null)?.message).toContain("IDP_SAML_CONFIG");
  });

  it("cannot be combined with password sign-in", () => {
    expect(refused({ ...ON, PASSWORD_SIGN_IN: "on" })?.message).toContain("PASSWORD_SIGN_IN");
  });

  it("fingerprints claim, mapping, interval and the provider's identity and trust, not their order", () => {
    const base = {
      claim: "roles",
      mapping: { A: ["admin", "approver"], B: ["member"] },
      intervalSec: 3600,
    };
    const a = fingerprintOf(base, IDP);
    expect(
      fingerprintOf({ ...base, mapping: { B: ["member"], A: ["approver", "admin"] } }, IDP),
    ).toBe(a);
    expect(fingerprintOf(base, { ...IDP, certs: ["MIIC-cert-a"] })).toBe(a);
    for (const changed of [
      fingerprintOf({ ...base, mapping: { A: ["admin"], B: ["member"] } }, IDP),
      fingerprintOf({ ...base, claim: "groups" }, IDP),
      fingerprintOf({ ...base, intervalSec: 1800 }, IDP),
      fingerprintOf(base, { ...IDP, entityId: "https://other-idp.example/" }),
      fingerprintOf(base, { ...IDP, certs: ["MIIC-cert-b"] }),
      fingerprintOf(base, { ...IDP, emailDomains: "other.example" }),
      fingerprintOf(base, { ...IDP, ssoUrl: "https://other-idp.example/sso" }),
    ]) {
      expect(changed).not.toBe(a);
    }
    // Certificates are digested, never stored.
    expect(a).not.toContain("MIIC");
  });
});
