import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";

/**
 * Unit 16 — offboarding action. A single endpoint a console button (a
 * future unit) calls directly; no SCIM/webhook trigger exists here by
 * design (see spec §14 — "build the action first, wire the trigger
 * later").
 */
export const OffboardPersonRequest = Schema.Struct({
  personId: Schema.String,
  // TODO(auth feature unit): once `CurrentUserTag` is wired to a real
  // session (see `http/middleware/auth.ts`), derive this from the
  // authenticated caller instead of accepting it in the body.
  requestedByPersonId: Schema.String,
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

export const OffboardingGroup = HttpApiGroup.make("offboarding").add(
  HttpApiEndpoint.post("offboardPerson", "/api/v1/offboarding")
    .setPayload(OffboardPersonRequest)
    .addSuccess(OffboardPersonResponse),
);
