import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * `auth.ts` declares the deployment-configured identity provider through
 * `@better-auth/sso`'s `defaultSSO` option, whose own docstring calls it
 * "Default SSO provider configurations for testing."
 *
 * That was a deliberate choice: the code path is first-class (the plugin's
 * `findSAMLProvider` checks `defaultSSO` before the database, and
 * `registerSSOProvider` reserves any colliding providerId), and it is the
 * only way to declare a provider without hand-writing an `auth_sso_provider`
 * row. But upstream frames it as test-only, so an upgrade could change it —
 * and the failure mode is silent: the option would simply be ignored, SSO
 * sign-in would fall through to the database, find nothing, and the login
 * page would stop offering SSO at all.
 *
 * Asserted against the installed package rather than a running auth instance,
 * because importing `auth.ts` builds a BetterAuth instance and a Postgres
 * pool at module load.
 */
const SSO_DIST = join(import.meta.dir, "../node_modules/@better-auth/sso/dist");

/** The types file carries a content hash in its name, so find it rather than pinning it. */
const readTypes = (): string => {
  const name = readdirSync(SSO_DIST).find((f) => f.endsWith(".d.mts") && f.startsWith("index-"));
  if (!name) throw new Error("could not find the @better-auth/sso types file");
  return readFileSync(join(SSO_DIST, name), "utf8");
};

const readImpl = (): string => readFileSync(join(SSO_DIST, "index.mjs"), "utf8");

describe("@better-auth/sso defaultSSO", () => {
  it("is still a declared plugin option", () => {
    expect(readTypes()).toContain("defaultSSO?:");
  });

  it("is still consulted before the database when resolving a SAML provider", () => {
    const impl = readImpl();
    // The ordering is the whole contract: a config-declared provider must win
    // over, and not require, an auth_sso_provider row.
    const inDefault = impl.indexOf("options?.defaultSSO?.length");
    expect(inDefault).toBeGreaterThan(-1);
    const inDb = impl.indexOf('model: "ssoProvider"', inDefault);
    expect(inDb).toBeGreaterThan(inDefault);
  });

  it("still grants domainVerified to a defaultSSO provider, which is what makes it trusted", () => {
    // Without this, BetterAuth refuses to link a SAML identity to an existing
    // local account and the sign-in dead-ends with nothing logged outside
    // development.
    expect(readImpl()).toContain("domainVerification?.enabled ? { domainVerified: true }");
  });
});
