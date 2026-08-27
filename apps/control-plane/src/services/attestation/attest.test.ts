import { describe, expect, test } from "bun:test";
import type { DomainEvent } from "@cloudable/events";
import { Effect, Layer } from "effect";
import { EventBus } from "../EventBus";
import { attest, AttestationRejected } from "./attest";
import { AttestationError, AttestationRegistryTag, type AttestationMethod } from "./AttestationMethod";

const alwaysSucceeds = (orgId: string): AttestationMethod => ({
  method: "managed_identity",
  issueCredential: () => Effect.fail(new AttestationError({ reason: "not_supported" })),
  verifyCredential: () => Effect.succeed({ machineId: "m-1", orgId }),
});

const alwaysFails = (reason: string): AttestationMethod => ({
  method: "managed_identity",
  issueCredential: () => Effect.fail(new AttestationError({ reason: "not_supported" })),
  verifyCredential: () => Effect.fail(new AttestationError({ reason })),
});

/** A capturing `EventBus` test double — asserts on published events without a database. */
const testEventBus = (captured: DomainEvent[]) =>
  Layer.succeed(EventBus, {
    publish: (batch: ReadonlyArray<DomainEvent>) =>
      Effect.sync(() => {
        captured.push(...batch);
      }),
  } as unknown as EventBus);

const withRegistry = (methods: ReadonlyArray<AttestationMethod>) =>
  Layer.succeed(AttestationRegistryTag, new Map(methods.map((m) => [m.method, m] as const)));

describe("attest dispatch", () => {
  test("success: returns the verified identity and emits agent.attested", async () => {
    const captured: DomainEvent[] = [];
    const layer = Layer.merge(withRegistry([alwaysSucceeds("org-1")]), testEventBus(captured));

    const result = await Effect.runPromise(
      attest({ method: "managed_identity", orgId: "org-1", credential: "tok" }).pipe(Effect.provide(layer)),
    );

    expect(result).toEqual({ machineId: "m-1", orgId: "org-1" });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      type: "agent.attested",
      orgId: "org-1",
      actorType: "agent",
      actorId: "m-1",
      machineId: "m-1",
      payload: { method: "managed_identity" },
    });
  });

  test("verification failure: rejects with a typed error and emits agent.attestation_failed", async () => {
    const captured: DomainEvent[] = [];
    const layer = Layer.merge(withRegistry([alwaysFails("ERR_JWKS_NO_MATCHING_KEY")]), testEventBus(captured));

    const error = await Effect.runPromise(
      Effect.flip(
        attest({ method: "managed_identity", orgId: "org-1", credential: "tok" }).pipe(Effect.provide(layer)),
      ),
    );

    expect(error).toBeInstanceOf(AttestationRejected);
    expect(error.reason).toBe("ERR_JWKS_NO_MATCHING_KEY");
    expect(typeof error.requestId).toBe("string");

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      type: "agent.attestation_failed",
      orgId: "org-1",
      actorType: "system",
      machineId: null,
      payload: { method: "managed_identity", reason: "ERR_JWKS_NO_MATCHING_KEY" },
    });
  });

  test("org mismatch: a credential that verifies but resolves to a different org is rejected", async () => {
    const captured: DomainEvent[] = [];
    const layer = Layer.merge(withRegistry([alwaysSucceeds("org-other")]), testEventBus(captured));

    const error = await Effect.runPromise(
      Effect.flip(
        attest({ method: "managed_identity", orgId: "org-claimed", credential: "tok" }).pipe(
          Effect.provide(layer),
        ),
      ),
    );

    expect(error.reason).toBe("org_mismatch");
    // The failure event is scoped to the CLAIMED org, per attest()'s doc comment.
    expect(captured[0]).toMatchObject({ orgId: "org-claimed", payload: { reason: "org_mismatch" } });
  });

  test("unknown method: rejected without calling any registered method", async () => {
    const captured: DomainEvent[] = [];
    const layer = Layer.merge(withRegistry([]), testEventBus(captured));

    const error = await Effect.runPromise(
      Effect.flip(
        attest({ method: "join_token", orgId: "org-1", credential: "tok" }).pipe(Effect.provide(layer)),
      ),
    );

    expect(error.reason).toBe("unknown_method");
    expect(captured[0]).toMatchObject({ payload: { method: "join_token", reason: "unknown_method" } });
  });
});
