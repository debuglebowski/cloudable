import { Context, Data, type Effect } from "effect";

/**
 * A verified machine identity, established by exchanging an opaque
 * credential through an `AttestationMethod` — an attestation interface with
 * two methods, both taking opaque strings: agent gives a credential, control
 * plane verifies that credential and returns a machine identity.
 */
export interface MachineIdentity {
  readonly orgId: string;
  readonly machineId: string;
}

/** What an `issueCredential` caller (an org admin, ultimately) asserts about the credential it wants minted. */
export interface CredentialClaim {
  readonly orgId: string;
  readonly machineId: string;
}

export class AttestationError extends Data.TaggedError("AttestationError")<{
  /**
   * A short, safe machine-readable reason. Deliberately a plain `string`
   * (not a fixed union) — different `AttestationMethod` implementations
   * fail in different, method-specific ways (a join token can be
   * malformed or wrong-signature; a managed-identity token can also be
   * unsupported-operation, missing-claim, unknown-machine, or one of
   * `jose`'s own JWKS/JWT verification error codes) and each method owns
   * its own vocabulary here. This value is safe to put in the public
   * `agent.attestation_failed` event payload and in logs — every
   * `AttestationMethod` implementation must guarantee it never echoes back
   * any part of the credential itself (see the `managed_identity`
   * implementation's `classifyJwtError` for why that matters).
   */
  reason: string;
  /**
   * Best-effort identity the rejected credential *claimed* to be, decoded
   * without trusting its signature — present only when the credential had
   * enough structure to extract it. This lets the HTTP layer still
   * attribute an `agent.attestation_failed` event to an org/machine for a
   * wrong-signature credential. A fully garbage string won't decode at
   * all, and the caller falls back to an "unattributed" sentinel — see
   * `../../http/handlers/agent-protocol.ts`.
   */
  claimedOrgId?: string;
  claimedMachineId?: string;
  cause?: unknown;
}> {}

/**
 * Port for agent attestation. Both operations take/return opaque strings
 * so implementations can be swapped or added side by side without
 * changing callers: `JoinTokenAttestation.ts` is the first, build-first
 * implementation here; `managed-identity.ts` is the second (Azure IMDS,
 * verified against the published key set) — not a fallback path, both are
 * live concurrently, dispatched by `AttestationRegistryTag` below on the
 * request's own `method` field.
 */
export interface AttestationMethod {
  /** A stable name for this method — matches `AgentEvent`'s `payload.method` on `agent.attested`. */
  readonly method: "join_token" | "managed_identity";
  /** Mint a new opaque credential for the given claim (e.g. an org admin generating a join token). Methods whose credential is issued by an external party instead (Azure IMDS) fail with a `"not_supported"` reason. */
  issueCredential(claim: CredentialClaim): Effect.Effect<string, AttestationError>;
  /** Verify an opaque credential, returning the machine identity it attests to. */
  verifyCredential(credential: string): Effect.Effect<MachineIdentity, AttestationError>;
}

export class AttestationMethodTag extends Context.Tag("AttestationMethod")<
  AttestationMethodTag,
  AttestationMethod
>() {}

/**
 * Registry of active attestation method adapters, keyed by `method` name.
 * Modeled as a single `Context.Tag` over a lookup map — rather than one
 * `Context.Tag` per method, the pattern `Signer`/`SecretsProvider`/
 * `ProvisioningService` use — because those ports have exactly one adapter
 * active per deployment (swapped via `buildAppLive`'s `adapters` argument),
 * while `/attest` must support join-token AND managed-identity agents
 * concurrently against the same running control plane, dispatching on the
 * request's own `method` field. This is still "`Context.Tag` for
 * multi-adapter ports" per the shared conventions — just a Tag over a
 * registry rather than over a single swapped-in adapter.
 *
 * A future bare-metal implementation — another provider implementation, not
 * a special case — plugs into this same registry under
 * `method: "bare_metal"` — no interface change needed.
 */
export class AttestationRegistryTag extends Context.Tag("AttestationRegistry")<
  AttestationRegistryTag,
  ReadonlyMap<string, AttestationMethod>
>() {}
