import { Context, Data, type Effect } from "effect";

export class AttestationError extends Data.TaggedError("AttestationError")<{
  reason: string;
  cause?: unknown;
}> {}

/** The machine identity a verified credential attests to. */
export interface MachineIdentity {
  readonly machineId: string;
  readonly orgId: string;
}

/**
 * Port for agent attestation (docs/spec.md §9): "an attestation interface
 * with two methods, both taking opaque strings — agent: give me a
 * credential; control plane: verify this credential, return a machine
 * identity." One `AttestationMethod` implementation exists per `method`
 * value (`join_token`, `managed_identity`, and eventually bare metal — see
 * the note on `AttestationRegistryTag` below).
 *
 * ASSUMED INTERFACE, FLAGGED FOR RECONCILIATION: this file did not exist on
 * the branch this unit forked from — unit 3's join-token attestation work,
 * which this file is designed to sit alongside, had not yet landed. This is
 * unit 4's best-effort, minimal-compatible guess at the shape described in
 * the task brief and docs/spec.md §9. If unit 3's PR defines a differently
 * shaped `AttestationMethod`/`verifyCredential`, reconcile at merge —
 * `managed-identity.ts` only depends on the shape below, so retargeting it
 * at a renamed/reshaped port from unit 3 should be a small diff.
 */
export interface AttestationMethod {
  readonly method: string;

  /**
   * Mint a new opaque credential for this method, for methods where the
   * control plane itself is the issuer (e.g. an admin generating a join
   * token). Methods whose credential is issued by an external party instead
   * (Azure IMDS, for managed identity) fail with `not_supported` — see
   * `managed-identity.ts`.
   */
  issueCredential(): Effect.Effect<string, AttestationError>;

  /** Verify an opaque credential presented by an agent, returning the machine identity it attests to. */
  verifyCredential(credential: string): Effect.Effect<MachineIdentity, AttestationError>;
}

/**
 * Registry of active attestation method adapters, keyed by `method` name.
 * Modeled as a single `Context.Tag` over a lookup map — rather than one
 * `Context.Tag` per method, the pattern `Signer`/`SecretsProvider`/
 * `ProvisioningService` use — because those ports have exactly one adapter
 * active per deployment (swapped via `buildAppLive`'s `adapters` argument),
 * while `/attest` must support join-token AND managed-identity agents
 * concurrently against the same running control plane, dispatching on the
 * request's own `method` field. This is still "`Context.Tag` for
 * multi-adapter ports" per the unit brief's shared conventions — just a Tag
 * over a registry rather than over a single swapped-in adapter.
 *
 * A future bare-metal implementation (spec §9: "another provider
 * implementation, not a special case") plugs into this same registry under
 * `method: "bare_metal"` — no interface change needed, which is the point of
 * modeling this as a map rather than a fixed union of tags. Not implemented
 * here per the unit brief.
 */
export class AttestationRegistryTag extends Context.Tag("AttestationRegistry")<
  AttestationRegistryTag,
  ReadonlyMap<string, AttestationMethod>
>() {}
