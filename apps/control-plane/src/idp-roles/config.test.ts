import { describe, expect, it } from "bun:test";
import { DEFAULT_SAML_ROLE_CLAIM, parseIdpRolesConfig } from "./config";

const MAPPING = JSON.stringify({
  "Cloudable.Admin": "admin",
  "Cloudable.Member": "member",
  "Cloudable.Approver": "approver",
});

describe("parseIdpRolesConfig", () => {
  it("is off by default", () => {
    expect(parseIdpRolesConfig({}, true)).toBeNull();
    expect(
      parseIdpRolesConfig({ ROLES_FROM_IDP: "off", IDP_ROLE_MAPPING: MAPPING }, true),
    ).toBeNull();
  });

  it("parses a full config, with the SAML role attribute and deny as defaults", () => {
    const parsed = parseIdpRolesConfig({ ROLES_FROM_IDP: "on", IDP_ROLE_MAPPING: MAPPING }, true);
    expect(parsed).toEqual({
      claim: DEFAULT_SAML_ROLE_CLAIM,
      mapping: {
        "Cloudable.Admin": "admin",
        "Cloudable.Member": "member",
        "Cloudable.Approver": "approver",
      },
      unmapped: "deny",
    });
  });

  it("takes a custom claim name and the member fallback", () => {
    const parsed = parseIdpRolesConfig(
      {
        ROLES_FROM_IDP: "on",
        IDP_ROLE_MAPPING: MAPPING,
        IDP_ROLE_CLAIM: "groups",
        IDP_ROLE_UNMAPPED: "member",
      },
      true,
    );
    expect(parsed?.claim).toBe("groups");
    expect(parsed?.unmapped).toBe("member");
  });

  it("refuses to start rather than half-enable", () => {
    const on = { ROLES_FROM_IDP: "on", IDP_ROLE_MAPPING: MAPPING };
    expect(() => parseIdpRolesConfig({ ROLES_FROM_IDP: "yes" }, true)).toThrow(/ROLES_FROM_IDP/);
    expect(() => parseIdpRolesConfig(on, false)).toThrow(/IDP_SAML_CONFIG/);
    expect(() => parseIdpRolesConfig({ ...on, PASSWORD_SIGN_IN: "on" }, true)).toThrow(
      /PASSWORD_SIGN_IN/,
    );
    expect(() => parseIdpRolesConfig({ ROLES_FROM_IDP: "on" }, true)).toThrow(/IDP_ROLE_MAPPING/);
    expect(() =>
      parseIdpRolesConfig({ ROLES_FROM_IDP: "on", IDP_ROLE_MAPPING: "not json" }, true),
    ).toThrow(/not valid JSON/);
    expect(() =>
      parseIdpRolesConfig({ ROLES_FROM_IDP: "on", IDP_ROLE_MAPPING: "[]" }, true),
    ).toThrow(/JSON object/);
    expect(() =>
      parseIdpRolesConfig({ ROLES_FROM_IDP: "on", IDP_ROLE_MAPPING: "{}" }, true),
    ).toThrow(/empty/);
    expect(() =>
      parseIdpRolesConfig(
        { ROLES_FROM_IDP: "on", IDP_ROLE_MAPPING: JSON.stringify({ X: "superuser" }) },
        true,
      ),
    ).toThrow(/superuser/);
    expect(() => parseIdpRolesConfig({ ...on, IDP_ROLE_UNMAPPED: "admin" }, true)).toThrow(
      /IDP_ROLE_UNMAPPED/,
    );
  });
});
