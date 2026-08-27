import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { AttestationRejected } from "../../services/attestation/attest";

/**
 * `POST /api/v1/agent/attest` — the agent protocol's Attest operation
 * (docs/spec.md §23): exchange a platform credential for a machine
 * identity. `method` selects which registered `AttestationMethod` verifies
 * `credential` — see `services/attestation/AttestationMethod.ts`.
 *
 * DEFINED HERE, FLAGGED FOR RECONCILIATION: unit 3 owns this endpoint's
 * canonical shape. It did not exist on the branch this unit forked from, so
 * this is a minimal compatible definition built to the shape described in
 * this unit's brief. If unit 3's PR already defines `POST /api/v1/agent/
 * attest` with a different payload/response shape, reconcile at merge —
 * extend that endpoint's handler dispatch with the `managed_identity`
 * branch from `handlers/agent.ts` instead of keeping this file.
 */
// Kept structurally in sync with `AttestRequest`/`AttestResponse` in
// `@cloudable/contracts` (the agent's hand-authored, type-only view of this
// wire surface — spec §25 deliberately keeps the agent's dependency surface
// thin, so it does not depend on `effect`/`Schema` to derive these). The two
// are not generated from one source, but `attest()` takes a plain
// `AttestRequest` and this endpoint's decoded payload is passed straight
// into it (see `handlers/agent.ts`), so removing/renaming a field here
// without updating contracts fails the control plane's own typecheck.
const AttestPayload = Schema.Struct({
  method: Schema.Literal("join_token", "managed_identity"),
  orgId: Schema.String,
  credential: Schema.String,
});

const AttestSuccess = Schema.Struct({
  machineId: Schema.String,
  orgId: Schema.String,
});

export const AgentGroup = HttpApiGroup.make("agent").add(
  HttpApiEndpoint.post("attest", "/api/v1/agent/attest")
    .setPayload(AttestPayload)
    .addSuccess(AttestSuccess)
    .addError(AttestationRejected, { status: 401 }),
);
