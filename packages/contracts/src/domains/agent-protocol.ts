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
 * A package operation the control plane is asking this machine to perform.
 *
 * Handed out by the poll, performed by the agent, and reported back on the
 * next report. Every one of these was requested by a person — nothing in the
 * control plane enqueues work on its own, which is what keeps invariants 4
 * and 5 true now that the agent can change a machine.
 *
 * `packageName` is validated against `PACKAGE_NAME_PATTERN` before it is
 * written, again before it is handed out here, and once more by the agent
 * before it spawns anything. The agent runs as root, so this value must never
 * reach a shell, and it never does: the agent spawns an argv array.
 */
export interface PendingPackageAction {
  readonly id: string;
  readonly op: "install" | "uninstall";
  readonly packageName: string;
  /** Exact version to install. Null means whatever the distro's repo offers. */
  readonly versionPin: string | null;
}

/**
 * The package name grammar both ends enforce. Matches Debian policy closely
 * enough to be safe (`apt` itself is stricter) and excludes every shell
 * metacharacter, path separator and whitespace character.
 */
export const PACKAGE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9+._-]*$/;

export const isValidPackageName = (value: string): boolean =>
  value.length <= 128 && PACKAGE_NAME_PATTERN.test(value);

/**
 * `GET /api/v1/agent/poll` response body (200 only — a 304 has none).
 * Additive fields only, never a breaking reshape.
 *
 * `version` is the machine's `desiredStateVersion`, so an unchanged poll is a
 * 304 with no body. It used to be the constant `"v0-stub"`, which meant the
 * 304 path was real but could never fire.
 */
export interface DesiredStateResponse {
  readonly version: string;
  /**
   * Package names this machine is ALLOWED to have — a permission list, not an
   * install list. The agent does not install these; it installs what
   * `pendingActions` asks for. Sent so the agent can tell an allowed package
   * from an undeclared one locally.
   */
  readonly packages: readonly string[];
  readonly settings: Readonly<Record<string, unknown>>;
  readonly pendingActions: readonly PendingPackageAction[];
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

/**
 * What became of one action the agent collected.
 *
 * Reported as observed state, never as an audit event: the agent says what
 * happened and the control plane decides what that means and what to record
 * (invariant 12 — a user with root could otherwise write their own history).
 */
export interface PackageActionResult {
  readonly id: string;
  readonly outcome: "succeeded" | "failed";
  /**
   * On failure, the tail of the package manager's own stderr. Surfaced
   * verbatim, because "E: Unable to locate package foo" is the answer and
   * "install failed" is not.
   */
  readonly detail?: string;
  /**
   * The version actually present after an install, when the agent could
   * determine it. Compared against the pin to flag a mismatch — asking for
   * `nodejs 20` and silently getting 18 should not read as a clean install.
   */
  readonly installedVersion?: string;
}

/** `POST /api/v1/agent/report` request: observed state, submitted after the agent reconciles locally. */
export interface AgentReportRequest {
  readonly agentVersion: string;
  /** ISO 8601 — when the agent captured this observation, not when the control plane received it. */
  readonly observedAt: string;
  readonly installedPackages: readonly string[];
  /**
   * Installed version per package, but only for packages the poll named as
   * allowed — not the whole inventory.
   *
   * Versions are needed for exactly one thing: telling whether a pinned
   * package is at the version it was pinned to. Only declared entries carry
   * pins, so the declared set is the whole set of rows a version could matter
   * for. Sending versions for all ~800 packages on the machine instead would
   * be tens of KB every 30 seconds to answer a question about a handful.
   */
  readonly declaredPackageVersions?: Readonly<Record<string, string>>;
  readonly openPorts: readonly number[];
  readonly configState: ConfigState;
  /**
   * Bytes in use and provisioned on the persistent volume
   * (`MACHINE_PERSISTENT_VOLUME_PATH`), as the machine itself measures them.
   *
   * The control plane cannot get this from the cloud: a provider reports a snapshot's
   * PROVISIONED size, never its stored bytes, which is why every snapshot in the fleet
   * reported an identical 64 GiB regardless of content. Optional because a machine that
   * cannot measure it must still be able to report everything else.
   */
  readonly volumeUsage?: {
    /** The persistent volume — exactly what a "shallow" snapshot stores. */
    readonly persistent?: { readonly usedBytes: number; readonly totalBytes: number };
    /** The root filesystem — what a "full" snapshot adds on top. */
    readonly root?: { readonly usedBytes: number; readonly totalBytes: number };
  };
  /** Outcomes for actions collected since the last report. Absent when none ran. */
  readonly actionResults?: readonly PackageActionResult[];
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
