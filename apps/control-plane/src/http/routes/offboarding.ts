import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { CurrentUserAuthentication } from "../middleware/auth";

/**
 * Unit 16 — offboarding action. A single endpoint a console button (a
 * future unit) calls directly; no SCIM/webhook trigger exists here by
 * design (see spec §14 — "build the action first, wire the trigger
 * later").
 */
// `requestedByPersonId` is gone from the wire — derived from
// `CurrentUserTag.personId` in the handler, not trusted from the client.
export const OffboardPersonRequest = Schema.Struct({
  personId: Schema.String,
  reason: Schema.String,
});

export const OffboardPersonResponse = Schema.Struct({
  approvalId: Schema.String,
  // `"approved"` means the sequence below ran for at least an attempt at
  // every owned machine; any other status means it never started (a true
  // no-op beyond the approval record itself).
  status: Schema.Literal("approved", "pending", "rejected", "expired"),
  // Machines that completed the full stop -> clear owner -> archive sequence.
  machinesOffboarded: Schema.Array(Schema.String),
  // Machines whose sequence failed partway through — isolated from each
  // other, so one machine failing does not stop the rest from being
  // attempted. See `domain/offboarding/offboardPerson.ts`'s doc comment on
  // the residual risk of a machine left mid-sequence.
  machineFailures: Schema.Array(Schema.Struct({ machineId: Schema.String, reason: Schema.String })),
});

export const SyncOffboardingParams = Schema.Struct({
  approvalId: Schema.String,
});

export const OffboardingGroup = HttpApiGroup.make("offboarding")
  .add(
    HttpApiEndpoint.post("offboardPerson", "/api/v1/offboarding")
      .setPayload(OffboardPersonRequest)
      .addSuccess(OffboardPersonResponse),
  )
  .add(
    // Resumes a `"pending"` offboarding (single/dual approval mode) once its
    // approval has since been decided — `ApprovalService.decide()` has no
    // callback wiring this up automatically (same "sync" shape elevations
    // already use — see `domain/offboarding/offboardPerson.ts`'s
    // `resumeOffboarding` doc comment). A safe no-op if still pending or
    // already resumed once.
    HttpApiEndpoint.post("sync", "/api/v1/offboarding/:approvalId/sync")
      .setPath(SyncOffboardingParams)
      .addSuccess(OffboardPersonResponse),
  )
  .middleware(CurrentUserAuthentication);
