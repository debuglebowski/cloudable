import type { EventEnvelope } from "../envelope";

/**
 * Agent events: attestation of the control agent running on a machine.
 *
 * The agent never submits audit events — it reports state, and the control
 * plane derives events/checks from that state. These two
 * events describe the agent's own attestation handshake with the control
 * plane, not machine state it observed.
 */
export type AgentEvent =
  | (EventEnvelope & {
      type: "agent.attested";
      payload: { method: "join_token" | "managed_identity" };
    })
  | (EventEnvelope & {
      type: "agent.attestation_failed";
      payload: { method: string; reason: string };
    });
