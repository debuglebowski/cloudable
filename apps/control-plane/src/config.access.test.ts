import { describe, expect, it } from "bun:test";

/**
 * Two settings that decide who can get in, both read from the environment at deploy time and
 * never from the console: whether email and password sign-in exists at all, and whether an admin
 * may ever reach a machine they do not own. Same re-import trick as `config.idp.test.ts`, since
 * `config.ts` reads `process.env` once at module load.
 */
const loadConfig = async (env: Record<string, string | undefined>) => {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return (await import(`./config?access=${crypto.randomUUID()}`)) as typeof import("./config");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const IDP = {
  IDP_METADATA_URL: "https://login.microsoftonline.com/tenant/federationmetadata.xml",
  IDP_SAML_CONFIG: JSON.stringify({
    entityId: "https://sts.windows.net/tenant/",
    ssoUrl: "https://login.microsoftonline.com/tenant/saml2",
    sloUrl: "https://login.microsoftonline.com/tenant/saml2",
    emailDomains: "normain.com",
    certs: ["MIIC"],
  }),
};

describe("password sign-in", () => {
  it("is off by default once an identity provider is configured (production)", async () => {
    const { config } = await loadConfig({ ...IDP, PASSWORD_SIGN_IN: undefined });
    expect(config.passwordSignInEnabled).toBe(false);
  });

  it("is on by default with no identity provider (local development)", async () => {
    const { config } = await loadConfig({
      IDP_METADATA_URL: undefined,
      IDP_SAML_CONFIG: undefined,
      PASSWORD_SIGN_IN: undefined,
    });
    expect(config.passwordSignInEnabled).toBe(true);
  });

  it("follows PASSWORD_SIGN_IN when set, and refuses anything but on/off", async () => {
    expect(
      (await loadConfig({ ...IDP, PASSWORD_SIGN_IN: "on" })).config.passwordSignInEnabled,
    ).toBe(true);
    await expect(loadConfig({ PASSWORD_SIGN_IN: "yes" })).rejects.toThrow("PASSWORD_SIGN_IN");
  });
});

describe("admin access policy", () => {
  it("defaults to never", async () => {
    const { config } = await loadConfig({ ADMIN_ACCESS_POLICY: undefined });
    expect(config.adminAccessPolicy).toBe("never");
  });

  it("refuses a value it does not know, rather than guessing", async () => {
    await expect(loadConfig({ ADMIN_ACCESS_POLICY: "sometimes" })).rejects.toThrow(
      "ADMIN_ACCESS_POLICY",
    );
  });
});
