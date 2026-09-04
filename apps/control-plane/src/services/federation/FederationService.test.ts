import { describe, expect, test } from "bun:test";
import type { DomainEvent } from "@cloudable/events";
import type * as schema from "@cloudable/schema";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import { type AppConfig, AppConfigTag } from "../../config";
import { Db } from "../../db/layer";
import { EventBus } from "../EventBus";
import { LocalSignerLive } from "../Signer.local";
import { FederationError, FederationService, subjectForCustomer } from "./FederationService";

const testConfig: AppConfig = {
  databaseUrl: "unused",
  port: 3000,
  betterAuthSecret: "unused",
  betterAuthUrl: "unused",
  managedIdentityJwksUrl: "unused",
  managedIdentityAudience: "unused",
  federationIssuerUrl: "https://auth.test.cloudable.example",
  federationAudience: "api://AzureADTokenExchange",
  consoleOrigin: "unused",
  provisioningAdapter: "fake",
  localDockerControlPlaneUrl: "unused",
  azureSubscriptionId: null,
  azureMachinesResourceGroup: "unused",
  azureMachinesSubnetId: null,
  agentBinariesDir: "unused",
};

/** Captures every batch published through `EventBus`, without touching Postgres. */
const makeCapturingEventBusLive = (captured: DomainEvent[]) =>
  Layer.succeed(EventBus, {
    publish: (batch: ReadonlyArray<DomainEvent>) =>
      Effect.sync(() => {
        captured.push(...batch);
      }),
  } as unknown as EventBus);

/**
 * A `Db` that is never legitimately reached by the tenant-isolation
 * rejection path below (rejection is asserted to happen before any
 * persistence is attempted) — `null` makes any accidental access throw
 * loudly instead of silently succeeding.
 */
const UntouchedDbLive = Layer.succeed(Db, null as never);

/**
 * A `Db` that records every `integrations` insert/update instead of hitting
 * Postgres, and answers `select` from an in-memory row list — enough to
 * exercise `federateCredential`'s find-then-insert-or-update path (see its
 * doc comment: no unique constraint to upsert against, so it selects first).
 */
const makeRecordingDbLive = (rows: Array<{ id: string; config: unknown }>) => {
  const inserted: Array<Record<string, unknown>> = [];
  const updated: Array<{ id: string; set: Record<string, unknown> }> = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rows.map((row) => ({ id: row.id }))),
        }),
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        const id = `row-${inserted.length}`;
        inserted.push(row);
        rows.push({ id, config: row.config });
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: () => {
          const id = rows[0]?.id ?? "row-0";
          updated.push({ id, set });
          return Promise.resolve();
        },
      }),
    }),
  } as unknown as PostgresJsDatabase<typeof schema>;
  return { layer: Layer.succeed(Db, db), inserted, updated };
};

describe("FederationService.federateCredential — tenant isolation", () => {
  // The canonical case: a trust rule naming only the issuer accepts a token
  // minted for any customer — a single-line mistake with cross-tenant
  // consequences. A token minted
  // for tenant A's subject must be REJECTED by a trust rule bound to tenant
  // B's subject, even though both trust the same issuer.
  test("rejects tenant A's token against a trust rule bound to tenant B's subject, same issuer", async () => {
    const captured: DomainEvent[] = [];

    const program = Effect.gen(function* () {
      const federation = yield* FederationService;
      return yield* Effect.flip(
        federation.federateCredential({
          orgId: "org-1",
          customerId: "tenant-a",
          subscriptionId: "sub-1",
          trustRule: {
            issuer: testConfig.federationIssuerUrl,
            boundSubject: subjectForCustomer("tenant-b"), // bound to the WRONG tenant
          },
        }),
      );
    });

    const TestLive = FederationService.Default.pipe(
      Layer.provide(
        Layer.mergeAll(
          LocalSignerLive,
          makeCapturingEventBusLive(captured),
          Layer.succeed(AppConfigTag, testConfig),
          UntouchedDbLive,
        ),
      ),
    );

    const error = await Effect.runPromise(Effect.provide(program, TestLive));

    // Assert failure, with the specific typed rejection reason.
    expect(error).toBeInstanceOf(FederationError);
    expect(error.reason).toBe("subject_mismatch");

    // Assert `cloud.credential_rejected` was emitted (always-alert, per
    // docs/events.md) — and NOT `cloud.credential_federated`.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.type).toBe("cloud.credential_rejected");
    expect(captured[0]?.payload).toEqual({
      subject: subjectForCustomer("tenant-a"),
      reason: "subject_mismatch",
    });
    expect(captured[0]?.orgId).toBe("org-1");
  });

  test("accepts tenant A's token against tenant A's own trust rule, and persists + emits federated", async () => {
    const captured: DomainEvent[] = [];
    const fakeDb = makeRecordingDbLive([]);

    const program = Effect.gen(function* () {
      const federation = yield* FederationService;
      return yield* federation.federateCredential({
        orgId: "org-1",
        customerId: "tenant-a",
        subscriptionId: "sub-1",
        trustRule: {
          issuer: testConfig.federationIssuerUrl,
          boundSubject: subjectForCustomer("tenant-a"),
        },
      });
    });

    const TestLive = FederationService.Default.pipe(
      Layer.provide(
        Layer.mergeAll(
          LocalSignerLive,
          makeCapturingEventBusLive(captured),
          Layer.succeed(AppConfigTag, testConfig),
          fakeDb.layer,
        ),
      ),
    );

    const outcome = await Effect.runPromise(Effect.provide(program, TestLive));

    expect(outcome.subject).toBe(subjectForCustomer("tenant-a"));
    const [, payloadSegment] = outcome.token.split(".");
    const claims = JSON.parse(Buffer.from(payloadSegment as string, "base64url").toString("utf8"));
    expect(claims.sub).toBe(subjectForCustomer("tenant-a"));
    expect(claims.iss).toBe(testConfig.federationIssuerUrl);

    // First mint for this subject: no existing row, so it inserts.
    expect(fakeDb.inserted).toHaveLength(1);
    expect(fakeDb.inserted[0]?.kind).toBe("cloud");
    expect(fakeDb.inserted[0]?.identifier).toBe(subjectForCustomer("tenant-a"));
    expect(fakeDb.updated).toHaveLength(0);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.type).toBe("cloud.credential_federated");
    expect(captured[0]?.payload).toEqual({
      subject: subjectForCustomer("tenant-a"),
      subscriptionId: "sub-1",
    });
  });

  test("re-minting for the same customer updates the existing integrations row instead of duplicating it", async () => {
    // Seed as if a previous mint already ran for this subject.
    const fakeDb = makeRecordingDbLive([{ id: "existing-row", config: {} }]);

    const program = Effect.gen(function* () {
      const federation = yield* FederationService;
      return yield* federation.federateCredential({
        orgId: "org-1",
        customerId: "tenant-a",
        subscriptionId: "sub-2", // e.g. the customer moved subscriptions
        trustRule: {
          issuer: testConfig.federationIssuerUrl,
          boundSubject: subjectForCustomer("tenant-a"),
        },
      });
    });

    const TestLive = FederationService.Default.pipe(
      Layer.provide(
        Layer.mergeAll(
          LocalSignerLive,
          makeCapturingEventBusLive([]),
          Layer.succeed(AppConfigTag, testConfig),
          fakeDb.layer,
        ),
      ),
    );

    await Effect.runPromise(Effect.provide(program, TestLive));

    expect(fakeDb.inserted).toHaveLength(0);
    expect(fakeDb.updated).toHaveLength(1);
    expect(fakeDb.updated[0]?.id).toBe("existing-row");
    expect((fakeDb.updated[0]?.set.config as { subscriptionId: string }).subscriptionId).toBe(
      "sub-2",
    );
    expect(fakeDb.updated[0]?.set.removedAt).toBeNull();
  });
});

describe("FederationService.jwks / discoveryDocument / mintFederationToken", () => {
  const TestLive = FederationService.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        LocalSignerLive,
        makeCapturingEventBusLive([]),
        Layer.succeed(AppConfigTag, testConfig),
        UntouchedDbLive,
      ),
    ),
  );

  test("discoveryDocument points jwks_uri at this issuer's well-known JWKS path", async () => {
    const doc = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const federation = yield* FederationService;
          return yield* federation.discoveryDocument();
        }),
        TestLive,
      ),
    );
    expect(doc.issuer).toBe(testConfig.federationIssuerUrl);
    expect(doc.jwks_uri).toBe(`${testConfig.federationIssuerUrl}/.well-known/jwks.json`);
    expect(doc.id_token_signing_alg_values_supported).toEqual(["EdDSA"]);
  });

  test("jwks exposes the same public key used to sign mintFederationToken's output", async () => {
    const { jwks, token } = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const federation = yield* FederationService;
          const jwksDoc = yield* federation.jwks();
          const mintedToken = yield* federation.mintFederationToken("tenant-a");
          return { jwks: jwksDoc, token: mintedToken };
        }),
        TestLive,
      ),
    );

    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]?.kty).toBe("OKP");
    expect(jwks.keys[0]?.crv).toBe("Ed25519");

    const [, payloadSegment] = token.split(".");
    const claims = JSON.parse(Buffer.from(payloadSegment as string, "base64url").toString("utf8"));
    expect(claims.sub).toBe(subjectForCustomer("tenant-a"));
    expect(claims.aud).toBe(testConfig.federationAudience);
  });
});
