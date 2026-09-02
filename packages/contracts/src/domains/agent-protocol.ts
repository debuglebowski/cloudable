/**
 * Wire types for the control agent protocol: attest, poll,
 * report, and the optional wake fast path. Plain TS types, not Effect
 * Schema — this package stays framework-free so the agent's dependency
 * surface stays thin ("Agent: revisit triggers, not intentions").
 * The control plane's `HttpApiGroup` in
 * `apps/control-plane/src/http/routes/agent-protocol.ts` defines the
 * runtime-validated Effect Schema counterparts of these shapes.
 */

/**
 * The attestation methods wired end-to-end. One
 * `AttestationMethod` port implementation exists per value, dispatched by
 * the control plane's `AttestationRegistryTag` (see
 * `apps/control-plane/src/services/attestation/AttestationMethod.ts`) —
 * both are live concurrently, not a fallback chain.
 */
export type AttestMethod = "join_token" | "managed_identity";

/** `POST /api/v1/agent/attest` request: an opaque credential plus which method verifies it. */
export interface AttestRequest {
  readonly method: AttestMethod;
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

/**
 * Config state observed alongside installed packages — report
 * installed packages and config state. Deliberately narrow, not full
 * configuration coverage: which access methods (e.g. the web
 * terminal) the agent found an actually-running process for at observation
 * time. Cheap to observe and directly checkable against the corresponding
 * desired-state setting the same way `installedPackages` is checked
 * against the declared manifest, once one exists. Additive fields only,
 * same reasoning as `DesiredStateResponse`.
 */
export interface ConfigState {
  readonly runningAccessMethods: readonly string[];
}

/** `POST /api/v1/agent/report` request: observed state, submitted after the agent reconciles locally. */
export interface AgentReportRequest {
  readonly agentVersion: string;
  /** ISO 8601 — when the agent captured this observation, not when the control plane received it. */
  readonly observedAt: string;
  readonly installedPackages: readonly string[];
  readonly openPorts: readonly number[];
  readonly configState: ConfigState;
}

export interface AgentReportResponse {
  readonly acknowledged: true;
}

/**
 * The one message the optional `wake` websocket may carry (CP → agent).
 * No payload, and it cannot carry instructions — it only ever
 * means "poll now instead of waiting out the interval."
 */
export interface WakeMessage {
  readonly type: "pull_now";
}
