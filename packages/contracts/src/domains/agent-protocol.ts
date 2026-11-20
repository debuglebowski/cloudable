import type { AgentRelease, AgentUpdateReport } from "./agent-update";
import type {
  InstalledScanTool,
  InstalledScanner,
  VulnerabilityScanReport,
} from "./vulnerability-scan";

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
 * next report. Each one was asked for by a person, or required by a package's
 * approved *Ensure* setting (invariant 4). The agent does not know or care
 * which: it performs what it is handed.
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
  /**
   * For a `nix:` package, the nixpkgs commit to install from: the package's own
   * pin, else the org's `packages.nix.snapshot`. Absent for other managers, and
   * for a `nix:` package when neither is set, which the agent refuses: an
   * unpinned Nix install would take whatever nixpkgs is newest that day.
   */
  readonly nixpkgsCommit?: string;
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
 * Where a declared or reported package lives. `apt` is the default and carries
 * no prefix, so every existing name keeps its meaning. The others are written
 * `<manager>:<name>` (`npm:@openai/codex`, `pipx:black`, `cargo:ripgrep`):
 * apt names cannot contain a colon, so the two never collide.
 *
 * `npm`, `pipx` and `cargo` mean globally installed tools, and `nix` a package in
 * the machine user's Nix profile, named by its nixpkgs attribute (`nix:ripgrep`,
 * `nix:python3Packages.black`). The agent reports all four. `home` is declaration
 * only: software in the owner's home folder that no package manager knows about
 * (Playwright's Chromium). Nothing scans for it, so it is a record of what is
 * allowed, never a detection.
 *
 * Which of these Cloudable can install is `INSTALLABLE_PACKAGE_MANAGERS`.
 */
export const PACKAGE_MANAGERS = ["apt", "npm", "pipx", "cargo", "home", "nix"] as const;
export type PackageManagerName = (typeof PACKAGE_MANAGERS)[number];

/**
 * The managers Cloudable can install through, and so the only ones a package
 * can be set to *Ensure* for. One list on purpose: adding a manager here (and
 * teaching `apps/agent/src/apply-packages.ts` its commands) is all the ensure
 * feature needs to cover it.
 */
export const INSTALLABLE_PACKAGE_MANAGERS: readonly PackageManagerName[] = [
  "apt",
  "npm",
  "pipx",
  "cargo",
  "nix",
];

const PREFIXED_NAME_PATTERNS: Record<Exclude<PackageManagerName, "apt">, RegExp> = {
  // npm allows a scope and lowercase names; uppercase is tolerated for old packages.
  npm: /^(@[a-zA-Z0-9][a-zA-Z0-9._~-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._~-]*$/,
  pipx: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
  cargo: /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
  home: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
  // A nixpkgs attribute path: dot-separated identifiers (`python3Packages.black`).
  // Nix identifiers allow `'`, which is left out: no package worth naming needs it.
  nix: /^[a-zA-Z_][a-zA-Z0-9_+-]*(\.[a-zA-Z_][a-zA-Z0-9_+-]*)*$/,
};

/** Splits a declared name into its manager and bare name. Unknown prefixes return null. */
export const parseDeclaredPackageName = (
  value: string,
): { manager: PackageManagerName; name: string } | null => {
  const colon = value.indexOf(":");
  if (colon < 0) return { manager: "apt", name: value };
  const manager = value.slice(0, colon);
  if (!(PACKAGE_MANAGERS as readonly string[]).includes(manager) || manager === "apt") return null;
  return { manager: manager as PackageManagerName, name: value.slice(colon + 1) };
};

/** Whether Cloudable can install this declared name (see `INSTALLABLE_PACKAGE_MANAGERS`). */
export const isInstallablePackageName = (value: string): boolean => {
  const parsed = parseDeclaredPackageName(value);
  return parsed !== null && INSTALLABLE_PACKAGE_MANAGERS.includes(parsed.manager);
};

/**
 * The grammar a version pin must follow, per manager. Pins end up as package
 * manager arguments on the machine (never through a shell), and the `nix` one is
 * spliced into a flake reference, so each is held to what its manager means by a
 * version and nothing more.
 *
 * - apt, npm, pipx, cargo: a version or range, no whitespace or shell syntax.
 * - nix: a nixpkgs commit (40 hex characters). Nix pins a snapshot of the whole
 *   package collection, not a package version; see `packages.nix.snapshot`.
 */
const VERSION_PIN_PATTERNS: Record<Exclude<PackageManagerName, "home">, RegExp> = {
  apt: /^[a-zA-Z0-9][a-zA-Z0-9.+~:-]*$/,
  npm: /^[a-zA-Z0-9^~<>=*][a-zA-Z0-9^~<>=.*|-]*$/,
  pipx: /^[a-zA-Z0-9][a-zA-Z0-9.!+*-]*$/,
  cargo: /^[a-zA-Z0-9^~<>=*][a-zA-Z0-9^~<>=.*+-]*$/,
  nix: /^[0-9a-f]{40}$/,
};

export const NIXPKGS_COMMIT_PATTERN = VERSION_PIN_PATTERNS.nix;

/** Whether `pin` is a usable version pin for the package `packageName` (a declared name). */
export const isValidVersionPin = (packageName: string, pin: string): boolean => {
  if (pin.length === 0 || pin.length > 64) return false;
  const parsed = parseDeclaredPackageName(packageName);
  if (!parsed || parsed.manager === "home") return false;
  return VERSION_PIN_PATTERNS[parsed.manager].test(pin);
};

/** The grammar a manifest entry's name must follow: an apt name, or `<manager>:<name>`. */
export const isValidDeclaredPackageName = (value: string): boolean => {
  if (value.length > 160) return false;
  const parsed = parseDeclaredPackageName(value);
  if (!parsed) return false;
  if (parsed.manager === "apt") return isValidPackageName(parsed.name);
  return parsed.name.length > 0 && PREFIXED_NAME_PATTERNS[parsed.manager].test(parsed.name);
};

/**
 * `GET /api/v1/agent/poll` response body (200 only — a 304 has none).
 * Additive fields only, never a breaking reshape.
 *
 * `version` is the machine's `desiredStateVersion`, so an unchanged poll is a
 * 304 with no body. It used to be the constant `"v0-stub"`, which meant the
 * 304 path was real but could never fire.
 */
export interface DesiredStateResponse {
  readonly agentRelease?: AgentRelease;
  readonly version: string;
  /**
   * Package names this machine is ALLOWED to have. The agent does not install
   * these; it installs what `pendingActions` asks for, which for an *Ensure*
   * package the control plane queues on its own. Sent so the agent can tell an
   * allowed package from an undeclared one locally, and so it knows which
   * versions to report.
   */
  readonly packages: readonly string[];
  /**
   * Org settings the agent acts on, keyed by name. Empty unless something applies.
   * Today the one key is `vulnerabilityScan` (`VulnerabilityScanConfig`), present only
   * while an admin has scanning turned on for the org. The agent treats any key it does
   * not know as absent and validates the ones it does, because the value is acted on as root.
   */
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
  readonly agentUpdate?: AgentUpdateReport;
  readonly agentVersion: string;
  /** ISO 8601 — when the agent captured this observation, not when the control plane received it. */
  readonly observedAt: string;
  readonly installedPackages: readonly string[];
  /**
   * The subset of `installedPackages` someone installed on purpose
   * (`apt-mark showmanual`). Everything else was pulled in as a dependency.
   * Absent when the agent cannot tell (no apt, or an older agent): then every
   * installed package counts as possibly intended.
   */
  readonly manuallyInstalledPackages?: readonly string[];
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
  /**
   * For the same allowed set: the newest version the machine's package
   * repository offers (apt's "Candidate"), read from the lists the OS already
   * keeps. The agent never refreshes those lists for this. The control plane
   * compares it with the installed version to decide whether an *Ensure latest
   * version* package needs updating. Optional: an older agent omits it, and
   * its machine simply gets no updates.
   */
  readonly availablePackageVersions?: Readonly<Record<string, string>>;
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
  /**
   * The security baseline label read from the machine's own stamp file
   * (`HARDENING_STAMP_PATH`). Absent means the machine carries none: it predates the
   * baseline, or its baseline failed. Never "none" on the wire; the export says that.
   */
  readonly hardeningBaseline?: string;
  /** Outcomes for actions collected since the last report. Absent when none ran. */
  readonly actionResults?: readonly PackageActionResult[];
  /**
   * The vulnerability scanner as installed on this machine. Absent when none is. The
   * control plane compares it with what it last stored and records
   * `machine.scanner_installed` when it changed; the agent never says "I installed it".
   */
  readonly scanner?: InstalledScanner;
  /**
   * The other scan tools on this machine (cargo-auditable, vulnix), as found. Compared the
   * same way as `scanner`, each change recorded as `machine.scanner_installed`.
   */
  readonly scanTools?: readonly InstalledScanTool[];
  /**
   * The result of a scan that finished since the last acknowledged report. Sent again on
   * the next report if this one is not acknowledged; `scanId` makes that safe.
   */
  readonly vulnerabilityScan?: VulnerabilityScanReport;
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
