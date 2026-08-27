/** The two attestation methods wired end-to-end as of this unit (see docs/spec.md §9). */
export type AttestMethod = "join_token" | "managed_identity";

/**
 * `POST /api/v1/agent/attest` request body.
 *
 * `orgId` is the org the agent *claims* to belong to. It is not proof of
 * anything by itself — `credential` is what the control plane actually
 * verifies — but it lets the control plane scope its lookup and, critically,
 * gives a REJECTED attestation (where no identity is ever confirmed) a
 * non-null org to log its `agent.attestation_failed` event against, since
 * `events.org_id` is `NOT NULL` for every event (docs/spec.md §24).
 */
export interface AttestRequest {
  method: AttestMethod;
  orgId: string;
  credential: string;
}

/** `POST /api/v1/agent/attest` success response: the verified machine identity. */
export interface AttestResponse {
  machineId: string;
  orgId: string;
}
