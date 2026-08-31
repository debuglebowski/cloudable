import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { AttestationError, type MachineIdentity } from "./AttestationMethod";
import { makeManagedIdentityAttestation } from "./managed-identity";

const AUDIENCE = "https://management.azure.com/";
const RESOURCE_ID =
  "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-1";
const TENANT_ID = "11111111-1111-1111-1111-111111111111";

/** Always fails — used wherever a test asserts verification never reaches this resolver. */
const shouldNotBeCalled = () =>
  Effect.fail(new AttestationError({ reason: "should_not_be_called" }));

/** Serves an in-memory JWKS document over a real local HTTP server, so `createRemoteJWKSet` exercises a genuine fetch. */
function serveJwks(jwks: { keys: unknown[] }) {
  return Bun.serve({ port: 0, fetch: () => Response.json(jwks) });
}

describe("managed-identity attestation", () => {
  test("accepts a token signed by a key present in the published JWKS", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    const server = serveJwks({ keys: [{ ...publicJwk, kid: "key-1", alg: "RS256", use: "sig" }] });

    try {
      const token = await new SignJWT({ xms_mirid: RESOURCE_ID, tid: TENANT_ID })
        .setProtectedHeader({ alg: "RS256", kid: "key-1" })
        .setIssuedAt()
        .setExpirationTime("5m")
        .setAudience(AUDIENCE)
        .sign(privateKey);

      const method = makeManagedIdentityAttestation({
        jwksUrl: `http://localhost:${server.port}/keys`,
        audience: AUDIENCE,
        resolveMachine: (claims) =>
          Effect.succeed({
            machineId: "m-1",
            orgId: claims.xms_mirid === RESOURCE_ID ? "org-1" : "org-wrong",
          } satisfies MachineIdentity),
        resolveExpectedTenantId: (orgId) =>
          Effect.succeed(orgId === "org-1" ? TENANT_ID : "org-wrong-tenant"),
      });

      const identity = await Effect.runPromise(method.verifyCredential(token));
      expect(identity).toEqual({ machineId: "m-1", orgId: "org-1" });
    } finally {
      server.stop(true);
    }
  });

  test("accepts a matching tid that differs only in case/whitespace from the configured tenant id", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    const server = serveJwks({ keys: [{ ...publicJwk, kid: "key-1", alg: "RS256", use: "sig" }] });

    try {
      const token = await new SignJWT({ xms_mirid: RESOURCE_ID, tid: TENANT_ID.toUpperCase() })
        .setProtectedHeader({ alg: "RS256", kid: "key-1" })
        .setIssuedAt()
        .setExpirationTime("5m")
        .setAudience(AUDIENCE)
        .sign(privateKey);

      const method = makeManagedIdentityAttestation({
        jwksUrl: `http://localhost:${server.port}/keys`,
        audience: AUDIENCE,
        resolveMachine: () => Effect.succeed({ machineId: "m-1", orgId: "org-1" }),
        // An org admin's console input, stored with incidental leading/trailing whitespace.
        resolveExpectedTenantId: () => Effect.succeed(`  ${TENANT_ID}  `),
      });

      const identity = await Effect.runPromise(method.verifyCredential(token));
      expect(identity).toEqual({ machineId: "m-1", orgId: "org-1" });
    } finally {
      server.stop(true);
    }
  });

  test("rejects a token signed correctly, with a resolvable machine, but carrying the wrong tid — tenant pinning catches it here, not just via an unrelated downstream lookup", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    const server = serveJwks({ keys: [{ ...publicJwk, kid: "key-1", alg: "RS256", use: "sig" }] });
    const WRONG_TENANT_ID = "22222222-2222-2222-2222-222222222222";

    try {
      const token = await new SignJWT({ xms_mirid: RESOURCE_ID, tid: WRONG_TENANT_ID })
        .setProtectedHeader({ alg: "RS256", kid: "key-1" })
        .setIssuedAt()
        .setExpirationTime("5m")
        .setAudience(AUDIENCE)
        .sign(privateKey);

      const method = makeManagedIdentityAttestation({
        jwksUrl: `http://localhost:${server.port}/keys`,
        audience: AUDIENCE,
        // Resolves to a real machine/org — signature, audience, and
        // `xms_mirid` lookup all succeed. Only the tenant is wrong.
        resolveMachine: () => Effect.succeed({ machineId: "m-1", orgId: "org-1" }),
        // org-1's actually-configured tenant does not match the token's `tid`.
        resolveExpectedTenantId: () => Effect.succeed(TENANT_ID),
      });

      const error = await Effect.runPromise(Effect.flip(method.verifyCredential(token)));

      expect(error).toBeInstanceOf(AttestationError);
      expect(error.reason).toBe("tenant_mismatch");
      // Still attributable to the real, resolved org/machine (unlike a
      // pre-signature-check rejection, this one has a trustworthy identity
      // to attribute to) — see `AttestationError.claimedOrgId`'s doc comment.
      expect(error.claimedOrgId).toBe("org-1");
      expect(error.claimedMachineId).toBe("m-1");
    } finally {
      server.stop(true);
    }
  });

  test("rejects a token with no tid claim at all", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    const server = serveJwks({ keys: [{ ...publicJwk, kid: "key-1", alg: "RS256", use: "sig" }] });

    try {
      const token = await new SignJWT({ xms_mirid: RESOURCE_ID })
        .setProtectedHeader({ alg: "RS256", kid: "key-1" })
        .setIssuedAt()
        .setExpirationTime("5m")
        .setAudience(AUDIENCE)
        .sign(privateKey);

      const method = makeManagedIdentityAttestation({
        jwksUrl: `http://localhost:${server.port}/keys`,
        audience: AUDIENCE,
        resolveMachine: () => Effect.succeed({ machineId: "m-1", orgId: "org-1" }),
        resolveExpectedTenantId: () => Effect.succeed(TENANT_ID),
      });

      const error = await Effect.runPromise(Effect.flip(method.verifyCredential(token)));

      expect(error).toBeInstanceOf(AttestationError);
      expect(error.reason).toBe("tenant_mismatch");
    } finally {
      server.stop(true);
    }
  });

  test("rejects a token signed by a key NOT in the published JWKS — typed error, no token material leaked", async () => {
    const { privateKey: attackerKey } = await generateKeyPair("RS256");
    const { publicKey: publishedKey } = await generateKeyPair("RS256");
    const publishedJwk = await exportJWK(publishedKey);
    const server = serveJwks({
      keys: [{ ...publishedJwk, kid: "published-key", alg: "RS256", use: "sig" }],
    });

    try {
      const token = await new SignJWT({ xms_mirid: RESOURCE_ID })
        .setProtectedHeader({ alg: "RS256", kid: "attacker-key" })
        .setIssuedAt()
        .setExpirationTime("5m")
        .setAudience(AUDIENCE)
        .sign(attackerKey);

      const method = makeManagedIdentityAttestation({
        jwksUrl: `http://localhost:${server.port}/keys`,
        audience: AUDIENCE,
        resolveMachine: () => Effect.fail(new AttestationError({ reason: "should_not_be_called" })),
        resolveExpectedTenantId: shouldNotBeCalled,
      });

      const error = await Effect.runPromise(Effect.flip(method.verifyCredential(token)));

      expect(error).toBeInstanceOf(AttestationError);
      expect(error).toHaveProperty("_tag", "AttestationError");
      expect(error.reason).toBe("ERR_JWKS_NO_MATCHING_KEY");
      expect(error.cause).toBeUndefined();

      // No part of the credential (header, payload, or signature segments)
      // may reach the error's own serialized form or string message.
      const tokenSegments = token.split(".");
      const serialized = JSON.stringify(error);
      const stringified = String(error);
      for (const segment of tokenSegments) {
        expect(serialized).not.toContain(segment);
        expect(stringified).not.toContain(segment);
      }
      expect(error.message).toBe("");
    } finally {
      server.stop(true);
    }
  });

  test("rejects a malformed (non-JWT) credential without leaking it", async () => {
    const server = serveJwks({ keys: [] });
    const malformedCredential = "not-a-jwt-at-all";

    try {
      const method = makeManagedIdentityAttestation({
        jwksUrl: `http://localhost:${server.port}/keys`,
        audience: AUDIENCE,
        resolveMachine: () => Effect.fail(new AttestationError({ reason: "should_not_be_called" })),
        resolveExpectedTenantId: shouldNotBeCalled,
      });

      const error = await Effect.runPromise(
        Effect.flip(method.verifyCredential(malformedCredential)),
      );

      expect(error).toBeInstanceOf(AttestationError);
      expect(JSON.stringify(error)).not.toContain(malformedCredential);
      expect(String(error)).not.toContain(malformedCredential);
    } finally {
      server.stop(true);
    }
  });

  test("issueCredential fails — Azure IMDS, not the control plane, issues managed-identity credentials", async () => {
    const method = makeManagedIdentityAttestation({
      jwksUrl: "http://localhost:1/keys",
      audience: AUDIENCE,
      resolveMachine: () => Effect.fail(new AttestationError({ reason: "should_not_be_called" })),
      resolveExpectedTenantId: shouldNotBeCalled,
    });
    const error = await Effect.runPromise(
      Effect.flip(method.issueCredential({ orgId: "org-1", machineId: "machine-1" })),
    );
    expect(error.reason).toBe("not_supported");
  });
});
