import type { AttestMethod, AttestRequest, AttestResponse } from "@cloudable/contracts";
import { Effect, Schema } from "effect";
import { ulid } from "ulid";
import { EventBus } from "../EventBus";
import { AttestationRegistryTag } from "./AttestationMethod";

/** Typed 401 returned by `POST /api/v1/agent/attest` on any rejection. */
export class AttestationRejected extends Schema.TaggedError<AttestationRejected>()("AttestationRejected", {
  reason: Schema.String,
  requestId: Schema.String,
}) {}

/**
 * Dispatches an `/attest` request to the registered `AttestationMethod` for
 * its `method`, and emits `agent.attested` / `agent.attestation_failed`
 * itself — per docs/spec.md §23, "`agent.attestation_failed` is emitted by
 * the control plane, which is the party doing the rejecting" — so this
 * function alone (not the thin HTTP handler wrapping it) is the whole unit
 * under test.
 *
 * `input.orgId` is the org the agent *claims* to belong to (see
 * `AttestRequest`'s doc comment in `@cloudable/contracts`). It is compared
 * against the verified machine's real `orgId` as a defense-in-depth
 * tenant-isolation check — a credential that verifies but resolves to a
 * machine in a different org is still rejected — and it is what every
 * emitted event (including a rejected one, where no identity is ever
 * confirmed) is scoped to, since `events.org_id` is `NOT NULL`.
 */
export const attest = (
  input: AttestRequest,
): Effect.Effect<AttestResponse, AttestationRejected, AttestationRegistryTag | EventBus> =>
  Effect.gen(function* () {
    const registry = yield* AttestationRegistryTag;
    const eventBus = yield* EventBus;
    const requestId = ulid();
    const correlationId = ulid();
    const method: AttestMethod = input.method;

    const reject = (reason: string) =>
      Effect.gen(function* () {
        yield* eventBus
          .publish([
            {
              // `id`/`recordedAt` are placeholders `EventBus.publish`
              // overwrites unconditionally (see its own doc comment) — kept
              // here only to satisfy `DomainEvent`'s type.
              id: "",
              recordedAt: new Date(),
              type: "agent.attestation_failed",
              occurredAt: new Date(),
              orgId: input.orgId,
              // No verified identity exists on a rejected attestation — the
              // control plane itself is the actor recording the rejection
              // (see envelope docs: actor_id is only meaningful for
              // non-system actors).
              actorType: "system",
              actorId: "system",
              machineId: null,
              correlationId,
              schemaVersion: 1,
              payload: { method, reason },
            },
          ])
          // A failure to durably record the rejection is an infra fault,
          // not a credential problem — treated as a defect (500 via the
          // generic error mapper) rather than folded into this endpoint's
          // one declared, 401 `AttestationRejected` error.
          .pipe(Effect.orDie);
        return yield* Effect.fail(new AttestationRejected({ reason, requestId }));
      });

    const impl = registry.get(method);
    if (!impl) {
      return yield* reject("unknown_method");
    }

    const verified = yield* impl.verifyCredential(input.credential).pipe(
      Effect.catchAll((error) => reject(error.reason)),
    );

    if (verified.orgId !== input.orgId) {
      return yield* reject("org_mismatch");
    }

    yield* eventBus
      .publish([
        {
          id: "",
          recordedAt: new Date(),
          type: "agent.attested",
          occurredAt: new Date(),
          orgId: verified.orgId,
          actorType: "agent",
          actorId: verified.machineId,
          machineId: verified.machineId,
          correlationId,
          schemaVersion: 1,
          payload: { method },
        },
      ])
      .pipe(Effect.orDie);

    return { machineId: verified.machineId, orgId: verified.orgId };
  });
