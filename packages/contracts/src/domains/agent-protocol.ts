/**
 * Wire types for the control agent protocol (spec §23): attest, poll,
 * report, and the optional wake fast path. Plain TS types, not Effect
 * Schema — this package stays framework-free so the agent's dependency
 * surface stays thin (see CLAUDE.md / docs/spec.md §25 "Agent: revisit
 * triggers, not intentions"). The control plane's `HttpApiGroup` in
 * `apps/control-plane/src/http/routes/agent-protocol.ts` defines the
 * runtime-validated Effect Schema counterparts of these shapes.
 */

/** `POST /api/v1/agent/attest` request: an opaque credential (a join token, for now). */
export interface AttestRequest {
  readonly credential: string;
}

/** `POST /api/v1/agent/attest` response: a short-lived bearer token for subsequent calls. */
export interface AttestResponse {
  readonly bearerToken: string;
  /** ISO 8601. The agent re-attests once a call is rejected past this time. */
  readonly expiresAt: string;
  readonly orgId: string;
  readonly machineId: string;
}

/**
 * `GET /api/v1/agent/poll` response body (200 only — a 304 has none).
 * Deliberately minimal: the real package manifest (docs/inheritance.md) is
 * a different unit's responsibility. Additive fields only, never a
 * breaking reshape, once something depends on more of this.
 */
export interface DesiredStateResponse {
  readonly version: string;
  readonly packages: readonly string[];
  readonly settings: Readonly<Record<string, unknown>>;
}

/** `POST /api/v1/agent/report` request: observed state, submitted after the agent reconciles locally. */
export interface AgentReportRequest {
  readonly agentVersion: string;
  /** ISO 8601 — when the agent captured this observation, not when the control plane received it. */
  readonly observedAt: string;
  readonly installedPackages: readonly string[];
  readonly openPorts: readonly number[];
}

export interface AgentReportResponse {
  readonly acknowledged: true;
}

/**
 * The one message the optional `wake` websocket may carry (CP → agent),
 * spec §23. No payload, and it cannot carry instructions — it only ever
 * means "poll now instead of waiting out the interval."
 */
export interface WakeMessage {
  readonly type: "pull_now";
}
