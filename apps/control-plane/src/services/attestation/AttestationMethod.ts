import { Context, Data, type Effect } from "effect";

/**
 * A verified machine identity, established by exchanging an opaque
 * credential through an `AttestationMethod` (spec §9: "an attestation
 * interface with two methods, both taking opaque strings — agent: give me
 * a credential; control plane: verify this credential, return a machine
 * identity").
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
  reason: "malformed_credential" | "invalid_signature";
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
 * implementation here; unit 4 adds Azure managed identity (token from
 * IMDS, verified against the published key set) as a second, alongside
 * this one — not a fallback path.
 */
export interface AttestationMethod {
  /** A stable name for this method — matches `AgentEvent`'s `payload.method` on `agent.attested`. */
  readonly method: "join_token" | "managed_identity";
  /** Mint a new opaque credential for the given claim (e.g. an org admin generating a join token). */
  issueCredential(claim: CredentialClaim): Effect.Effect<string, AttestationError>;
  /** Verify an opaque credential, returning the machine identity it attests to. */
  verifyCredential(credential: string): Effect.Effect<MachineIdentity, AttestationError>;
}

export class AttestationMethodTag extends Context.Tag("AttestationMethod")<
  AttestationMethodTag,
  AttestationMethod
>() {}
