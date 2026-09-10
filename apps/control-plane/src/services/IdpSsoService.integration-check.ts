import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { authSsoProvider, orgs, people } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { Effect } from "effect";
import postgres from "postgres";
import { auth } from "../auth";
import { config } from "../config";
import { deleteSamlProvider, registerSamlProvider } from "./IdpSsoService";

/**
 * Real Postgres, a real signed-in BetterAuth session (`registerSSOProvider`
 * requires one — see `IdpSsoService.ts`), and a real HTTP fetch of a
 * locally-served static metadata fixture (not a live third-party IdP, not a
 * mocked `fetch`) — same "needs real infra, not a testcontainer" reasoning
 * as `auth.integration-check.ts`, since `auth.ts`'s BetterAuth instance is a
 * module-level singleton bound to `config.databaseUrl` at import time.
 */
const TEST_CERT =
  "MIIDJzCCAg+gAwIBAgIUUjGmMIGkkOr7m2ZeANrOprI6rmAwDQYJKoZIhvcNAQELBQAwIzEhMB8GA1UEAwwYdGVzdC1pZHAuZXhhbXBsZS5pbnZhbGlkMB4XDTI2MDkwOTIwMjcxMloXDTM2MDkwNjIwMjcxMlowIzEhMB8GA1UEAwwYdGVzdC1pZHAuZXhhbXBsZS5pbnZhbGlkMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArmpPbusY7+/aghySSCbJjg3tVds4Ltqc6sOYE5c894HBJEDFQA5XiFopCyuJSzJvTtPEenf8X4qZqug12zrcuvqYYhrsz6WRcIQblan5toFTHFO0zs3EiZZ7CSeunnd2mADUjvA6DhL+oQ3+0SCcznv9nThEJn4+XJOqrBByfsm7aIJka89CLdT5p+rmyFoPN2g5jFK8cnIy7mom4vFqKfCSUA9McrlmdrwXKXisRL/Nk7kuKQd19IuFTOlIVqH8oQiiX/zhRJzArbVTLyoCFiBbHoJxcbdhrg6LUBQajsmrHjHyE9ssR5GLdZGwoVaS4arha0JqJroXBQrM219d/wIDAQABo1MwUTAdBgNVHQ4EFgQUcr5QRDkv98Jp/8zjCovMYzFArX0wHwYDVR0jBBgwFoAUcr5QRDkv98Jp/8zjCovMYzFArX0wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAgddbNqziRo891/Rs0zB6YkzutBN4aLAgHb//PmV4+QEEf9VxAyFwsCgf8Xq2l1kDQjJ0dBwJKjut3qE9JaIwJwTWcLQPC/nysNNeDE+ygbZg7IMMckooIwkL223vwH3FYGoJRc798TfJ41U88KINIZSV1dQE3aNjVzCEeS9Qvkz8qPEI+mjybsW0fPOCcJBsMjPF9RgBWoKXYWD4qcTEvhfociyLwmsTbTiUeQLQ2PSEusWAZ9GMJNfZOGkXRX08BzDggyp+hR3WzZwZjGC8aKurVsFf5NepTDadvOYSlCabrZZp+d8/ceLetbWZaDev+1ZYAkKsMfkv0Qv9Bux4Gw==";

const metadataXml = (entityId: string) => `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
        <ds:X509Data><ds:X509Certificate>${TEST_CERT}</ds:X509Certificate></ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${entityId}/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

const cookieHeaderFromSetCookies = (setCookies: ReadonlyArray<string>): string =>
  setCookies
    .filter(Boolean)
    .map((sc) => sc.split(";")[0])
    .join("; ");

describe("IdpSsoService registers and removes a real SAML provider", () => {
  const sql = postgres(config.databaseUrl);
  const db = drizzle(sql);
  let sessionHeaders!: Headers;
  let orgId!: string;

  beforeAll(async () => {
    const email = `sso-test-${crypto.randomUUID()}@example.com`;
    const [org] = await db.insert(orgs).values({ name: "sso-test-org" }).returning();
    if (!org) throw new Error("expected an inserted org row back");
    orgId = org.id;
    await db.insert(people).values({ orgId: org.id, email });

    // `asResponse` isn't part of this codebase's hand-rolled `AuthInstance`
    // surface (`../auth.ts`) — only this test needs the raw `Response` back,
    // to read its real `Set-Cookie` header.
    const signUpEmailAsResponse = auth.api.signUpEmail as unknown as (options: {
      body: { email: string; password: string; name: string };
      asResponse: true;
    }) => Promise<Response>;
    const response = await signUpEmailAsResponse({
      body: { email, password: "irrelevant-1234", name: "SSO Test" },
      asResponse: true,
    });
    const cookie = cookieHeaderFromSetCookies(response.headers.getSetCookie?.() ?? []);
    if (!cookie) throw new Error("sign-up succeeded but no session cookie was returned");
    sessionHeaders = new Headers({ cookie });
  });

  afterAll(async () => {
    await db.delete(people).where(eq(people.orgId, orgId));
    await db.delete(orgs).where(eq(orgs.id, orgId));
    await sql.end();
  });

  test("registerSamlProvider stores a row, deleteSamlProvider removes it", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(metadataXml(`https://test-idp-${crypto.randomUUID()}.example.invalid`), {
          headers: { "content-type": "application/xml" },
        }),
    });
    try {
      const providerId = `test-${crypto.randomUUID()}`;
      const outcome = await Effect.runPromiseExit(
        registerSamlProvider({
          providerId,
          metadataUrl: `http://localhost:${server.port}/metadata.xml`,
          headers: sessionHeaders,
        }),
      );

      expect(outcome._tag).toBe("Success");

      const rows = await db
        .select()
        .from(authSsoProvider)
        .where(eq(authSsoProvider.providerId, providerId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.samlConfig).toBeTruthy();

      await Effect.runPromise(deleteSamlProvider(providerId));

      const afterDelete = await db
        .select()
        .from(authSsoProvider)
        .where(eq(authSsoProvider.providerId, providerId));
      expect(afterDelete).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("registerSamlProvider fails clearly for a URL that isn't SAML metadata", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("not xml at all") });
    try {
      const outcome = await Effect.runPromiseExit(
        registerSamlProvider({
          providerId: `test-${crypto.randomUUID()}`,
          metadataUrl: `http://localhost:${server.port}/metadata.xml`,
          headers: sessionHeaders,
        }),
      );
      expect(outcome._tag).toBe("Failure");
    } finally {
      server.stop(true);
    }
  });
});
