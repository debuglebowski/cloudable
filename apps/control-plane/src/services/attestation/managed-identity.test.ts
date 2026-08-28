import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { AttestationError, type MachineIdentity } from "./AttestationMethod";
import { makeManagedIdentityAttestation } from "./managed-identity";

const AUDIENCE = "https://management.azure.com/";
const RESOURCE_ID =
  "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-1";

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
      const token = await new SignJWT({ xms_mirid: RESOURCE_ID })
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
            orgId: claims["xms_mirid"] === RESOURCE_ID ? "org-1" : "org-wrong",
          } satisfies MachineIdentity),
      });

      const identity = await Effect.runPromise(method.verifyCredential(token));
      expect(identity).toEqual({ machineId: "m-1", orgId: "org-1" });
    } finally {
      server.stop(true);
    }
  });

  test("rejects a token signed by a key NOT in the published JWKS — typed error, no token material leaked", async () => {
    const { privateKey: attackerKey } = await generateKeyPair("RS256");
    const { publicKey: publishedKey } = await generateKeyPair("RS256");
    const publishedJwk = await exportJWK(publishedKey);
    const server = serveJwks({ keys: [{ ...publishedJwk, kid: "published-key", alg: "RS256", use: "sig" }] });

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
      });

      const error = await Effect.runPromise(Effect.flip(method.verifyCredential(malformedCredential)));

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
    });
    const error = await Effect.runPromise(
      Effect.flip(method.issueCredential({ orgId: "org-1", machineId: "machine-1" })),
    );
    expect(error.reason).toBe("not_supported");
  });
});
