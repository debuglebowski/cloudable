import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type * as schema from "@cloudable/schema";
import { machines, orgs } from "@cloudable/schema";
import { inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect } from "effect";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { connectAndMigrate } from "../../test-support/db";
import { AttestationError, type MachineIdentity } from "./AttestationMethod";
import { makeManagedIdentityAttestation, resolveMachineByResourceId } from "./managed-identity";

const AUDIENCE = "https://management.azure.com/";
const RESOURCE_ID =
  "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-1";
const TENANT_ID = "11111111-1111-1111-1111-111111111111";

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
        resolveExpectedTenantId: Effect.succeed(TENANT_ID),
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
        // Incidental leading/trailing whitespace on the resolved value.
        resolveExpectedTenantId: Effect.succeed(`  ${TENANT_ID}  `),
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
        // This deployment's own resolved tenant does not match the token's `tid`.
        resolveExpectedTenantId: Effect.succeed(TENANT_ID),
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
        resolveExpectedTenantId: Effect.succeed(TENANT_ID),
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
        // Never reached in this test — verification fails before the tenant
        // check runs, so the value here is inert either way.
        resolveExpectedTenantId: Effect.succeed(null),
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
        // Never reached in this test — verification fails before the tenant
        // check runs, so the value here is inert either way.
        resolveExpectedTenantId: Effect.succeed(null),
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
      // Never reached in this test — verification fails before the tenant
      // check runs, so the value here is inert either way.
      resolveExpectedTenantId: Effect.succeed(null),
    });
    const error = await Effect.runPromise(
      Effect.flip(method.issueCredential({ orgId: "org-1", machineId: "machine-1" })),
    );
    expect(error.reason).toBe("not_supported");
  });
});

// Real Postgres, not a fake — `resolveMachineByResourceId`'s whole job is a real
// SQL comparison; only a real round trip can confirm it actually matches
// case-insensitively.
describe("resolveMachineByResourceId (requires Postgres)", () => {
  let close: () => Promise<void>;
  let db: PostgresJsDatabase<typeof schema>;
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    const databaseUrl =
      process.env.DATABASE_URL ?? "postgres://cloudable:cloudable@localhost:5442/cloudable";
    const conn = await connectAndMigrate(databaseUrl);
    db = conn.db;
    close = conn.close;
  });

  afterAll(async () => {
    if (createdOrgIds.length > 0) {
      await db.delete(machines).where(inArray(machines.orgId, createdOrgIds));
      await db.delete(orgs).where(inArray(orgs.id, createdOrgIds));
    }
    await close();
  });

  async function seedMachine(externalResourceId: string) {
    const [org] = await db
      .insert(orgs)
      .values({ name: `org-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("seed failed");
    createdOrgIds.push(org.id);

    const [machine] = await db
      .insert(machines)
      .values({
        orgId: org.id,
        name: "m1",
        provider: "azure",
        sizeSku: "Standard_D2s_v5",
        image: "ubuntu-24.04",
        externalResourceId,
      })
      .returning();
    if (!machine) throw new Error("seed failed");
    return machine;
  }

  // Regression: this is the exact real-world mismatch that made every fresh
  // Azure machine's attestation fail with "unknown_machine" — confirmed live
  // against a real stuck machine (an IMDS token's `xms_mirid` claim reads
  // "resourcegroups" lowercase; ARM's own get/list responses, which is what
  // populated `externalResourceId` here, read "resourceGroups").
  test("matches regardless of casing differences in the resourceGroups segment", async () => {
    const machine = await seedMachine(
      "/subscriptions/x/resourceGroups/rg-cloudable-managed/providers/Microsoft.Compute/virtualMachines/vm-1",
    );

    const identity = await Effect.runPromise(
      resolveMachineByResourceId(
        db,
        "/subscriptions/x/resourcegroups/rg-cloudable-managed/providers/Microsoft.Compute/virtualMachines/vm-1",
      ),
    );

    expect(identity).toEqual({ machineId: machine.id, orgId: machine.orgId });
  });

  test("fails with unknown_machine when genuinely no row matches", async () => {
    const error = await Effect.runPromise(
      Effect.flip(resolveMachineByResourceId(db, "/subscriptions/x/.../virtualMachines/nope")),
    );
    expect(error.reason).toBe("unknown_machine");
  });
});

/**
 * `resolveOwnTenantId` is module-private and its cache is module-level, so
 * this asserts the source rather than the behaviour.
 *
 * The invariant is narrow but expensive to lose: the cache must hold only a
 * SUCCESSFUL resolution. Caching a null turns one transient failure at
 * container start into a permanent one, because a null expected tenant makes
 * `verifyCredential` reject — so every agent on the deployment fails
 * `tenant_mismatch` until someone restarts it, with the reason pointing at
 * the agent's token rather than at the control plane. That ran in production
 * for hours at 720 failures an hour.
 */
describe("own-tenant resolution cache", () => {
  test("never caches a failed resolution", async () => {
    const source = await Bun.file(
      new URL("./managed-identity.ts", import.meta.url).pathname,
    ).text();
    const write = source
      .split("\n")
      .find((line) => /^\s*(if \(resolved !== null\) )?cachedOwnTenantId = /.test(line));

    expect(write).toBeDefined();
    expect(write).toContain("resolved !== null");
  });
});
