import { describe, expect, it } from "bun:test";

/**
 * `IDP_SAML_CONFIG` carries the identity provider's trust anchors, built by
 * Terraform from the federation metadata. It is deliberately NOT the metadata
 * document: Entra regenerates that document's EntityDescriptor ID and
 * enclosing Signature on every request, so passing the XML made the Container
 * App diff on every plan and restart on every apply.
 *
 * These tests cover the parsing contract, which is load-bearing in a way that
 * is easy to underestimate — a malformed value must stop the process rather
 * than quietly disable SSO, because a deployment that sets IDP_METADATA_URL
 * has declared in Terraform that it federates, and a console showing an
 * editable identity-provider card would be contradicting its own
 * infrastructure.
 *
 * `config.ts` reads `process.env` once at module load, so each case re-imports
 * it with a cache-busting query string.
 */
const loadConfig = async (env: Record<string, string | undefined>) => {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return (await import(`./config?idp=${crypto.randomUUID()}`)) as typeof import("./config");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const VALID = JSON.stringify({
  entityId: "https://sts.windows.net/tenant/",
  ssoUrl: "https://login.microsoftonline.com/tenant/saml2",
  certs: ["MIIC-fake-cert"],
});

describe("idpSamlConfig", () => {
  it("is null when nothing is configured, which is the console-driven default", async () => {
    const { config } = await loadConfig({
      IDP_METADATA_URL: undefined,
      IDP_SAML_CONFIG: undefined,
    });
    expect(config.idpSamlConfig).toBeNull();
    expect(config.idpMetadataUrl).toBeNull();
  });

  it("parses a complete value", async () => {
    const { config } = await loadConfig({
      IDP_METADATA_URL: "https://example.invalid/metadata.xml",
      IDP_SAML_CONFIG: VALID,
    });
    expect(config.idpSamlConfig?.entityId).toBe("https://sts.windows.net/tenant/");
    expect(config.idpSamlConfig?.certs).toEqual(["MIIC-fake-cert"]);
    expect(config.idpMetadataUrl).toBe("https://example.invalid/metadata.xml");
  });

  it("stays console-driven when only one of the two vars is set", async () => {
    // Half-configured is not a state worth supporting: a URL with no anchors
    // has nothing to authenticate against, and anchors with no URL leave the
    // console unable to say where they came from.
    const { config } = await loadConfig({
      IDP_METADATA_URL: "https://example.invalid/metadata.xml",
      IDP_SAML_CONFIG: undefined,
    });
    expect(config.idpSamlConfig).toBeNull();
    expect(config.idpMetadataUrl).toBeNull();
  });

  it("refuses a value missing certificates rather than disabling SSO silently", async () => {
    const incomplete = JSON.stringify({
      entityId: "https://sts.windows.net/tenant/",
      ssoUrl: "https://login.microsoftonline.com/tenant/saml2",
      certs: [],
    });
    await expect(
      loadConfig({
        IDP_METADATA_URL: "https://example.invalid/metadata.xml",
        IDP_SAML_CONFIG: incomplete,
      }),
    ).rejects.toThrow(/IDP_SAML_CONFIG/);
  });

  it("refuses malformed JSON", async () => {
    await expect(
      loadConfig({
        IDP_METADATA_URL: "https://example.invalid/metadata.xml",
        IDP_SAML_CONFIG: "{not json",
      }),
    ).rejects.toThrow(/IDP_SAML_CONFIG/);
  });
});
