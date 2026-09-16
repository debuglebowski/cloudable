import type { AuditActorType } from "@/api/audit";
import { ApiError, apiGet, apiPatch, apiPost } from "@/lib/api-client";
import type { ApiErrorBody } from "@cloudable/contracts";

export type MachineState =
  | "provisioning"
  | "running"
  | "stopped"
  | "archived_restorable"
  | "archived_expired"
  | "error";

export type MachineProvider = "azure" | "docker" | "fake";

export interface Machine {
  id: string;
  orgId: string;
  templateId: string | null;
  ownerPersonId: string | null;
  name: string;
  provider: MachineProvider;
  /** `null` for a provider with no region concept (docker/fake). */
  region: string | null;
  sizeSku: string;
  image: string;
  state: MachineState;
  /** The most recent provisioning failure message, if any — set whenever `state`
   * is `"error"`; cleared back to `null` by a later successful attempt. */
  lastError: string | null;
  lastVerifiedAt: string | null;
  archivedAt: string | null;
}

/** Mirrors control-plane's `REPORTING_STALENESS_THRESHOLD_MINUTES`
 * (`compliance/checks/machines-reporting.ts`) — can't import cross-app, kept
 * as the same literal value with this comment instead. */
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

/** `null` means "no agent poll has landed yet" — a normal, non-alarming
 * "not yet verified" state for a brand-new machine (see call sites' own
 * fallback text), not staleness, so this only ever returns `true` for a
 * machine that reported before and has since gone quiet. */
export function isMachineStale(lastVerifiedAt: string | null): boolean {
  return (
    lastVerifiedAt != null && Date.now() - new Date(lastVerifiedAt).getTime() > STALE_THRESHOLD_MS
  );
}

export type SettingLevel = "org" | "template" | "machine";

export interface ManifestEntry {
  package: string;
  /** `null` means "any" version — no pin. */
  version: string | null;
  source: SettingLevel;
  /** Org-level pin: cannot be overridden below. */
  pinned: boolean;
  /**
   * This machine declares the package must not be here, overriding the org.
   * Different from the package simply not being listed, which means "inherit".
   */
  excluded: boolean;
  /** Count of machines that override this entry below the level shown here. No real endpoint
   * aggregates this yet (see `getMachineManifest` below) — always undefined against real data. */
  overriddenBelow?: number;
}

export class ManifestOverrideError extends Error {
  readonly body: ApiErrorBody;
  constructor(body: ApiErrorBody) {
    super(body.error.message);
    this.name = "ManifestOverrideError";
    this.body = body;
  }
}

export type PackagePermission = "allowed" | "disallowed" | null;
export type PackageInstallState = "installed" | "not_installed" | "unknown";
export type PackageActionOp = "install" | "uninstall";
export type PackageActionStatus = "pending" | "running" | "succeeded" | "failed" | "expired";

export interface PendingPackageActionView {
  id: string;
  op: PackageActionOp;
  status: PackageActionStatus;
  requestedAt: string;
  failureReason?: string;
}

/** One row of the packages table. See `MachinePackageRow` in the contracts package. */
export interface MachinePackageRow {
  packageName: string;
  permission: PackagePermission;
  versionPin: string | null;
  source: SettingLevel | null;
  installed: PackageInstallState;
  installedVersion?: string;
  versionMismatch: boolean;
  isBaseline: boolean;
  pendingAction?: PendingPackageActionView;
}

export interface MachinePackagesResponse {
  items: MachinePackageRow[];
  lastReportedAt: string | null;
}

export class PackageActionError extends Error {
  readonly body: ApiErrorBody;
  constructor(body: ApiErrorBody) {
    super(body.error.message);
    this.name = "PackageActionError";
    this.body = body;
  }
}

export const machinesKeys = {
  all: ["machines"] as const,
  lists: () => [...machinesKeys.all, "list"] as const,
  list: (orgId?: string) => [...machinesKeys.lists(), orgId ?? "current"] as const,
  details: () => [...machinesKeys.all, "detail"] as const,
  detail: (machineId: string) => [...machinesKeys.details(), machineId] as const,
  manifest: (machineId: string) => [...machinesKeys.all, "manifest", machineId] as const,
  manifestHistory: (machineId: string) =>
    [...machinesKeys.all, "manifest-history", machineId] as const,
  packages: (machineId: string) => [...machinesKeys.all, "packages", machineId] as const,
};

interface MachineSummaryWire {
  id: string;
  orgId: string;
  templateId: string | null;
  ownerPersonId: string | null;
  name: string;
  provider: MachineProvider;
  region: string | null;
  sizeSku: string;
  image: string;
  state: MachineState;
  lastError: string | null;
  lastVerifiedAt: string | null;
  createdAt: string;
}

function toMachine(wire: MachineSummaryWire): Machine {
  return {
    id: wire.id,
    orgId: wire.orgId,
    templateId: wire.templateId,
    ownerPersonId: wire.ownerPersonId,
    name: wire.name,
    provider: wire.provider,
    region: wire.region,
    sizeSku: wire.sizeSku,
    image: wire.image,
    state: wire.state,
    lastError: wire.lastError,
    lastVerifiedAt: wire.lastVerifiedAt,
    // The real machines table has no archivedAt-on-summary field distinct from
    // `state` — "archived" is the state itself. Kept as a separate field here only
    // because the Machines/Archive pages both read it; derive it from state.
    archivedAt: wire.state.startsWith("archived") ? wire.lastVerifiedAt : null,
  };
}

interface ResolvedManifestEntryWire {
  packageName: string;
  versionPin: string | null;
  pinned: boolean;
  excluded: boolean;
  source: SettingLevel;
  resolvedFromScopeId: string;
}

interface MachineDetailWire extends MachineSummaryWire {
  manifest: ResolvedManifestEntryWire[];
}

function toManifestEntry(wire: ResolvedManifestEntryWire): ManifestEntry {
  return {
    package: wire.packageName,
    version: wire.versionPin,
    source: wire.source,
    pinned: wire.pinned,
    excluded: wire.excluded,
  };
}

export async function listMachines(): Promise<Machine[]> {
  const res = await apiGet<{ items: MachineSummaryWire[] }>("/api/v1/machines");
  return res.items.map(toMachine);
}

export interface CreateMachineInput {
  /** Optional — a friendly, org-unique default is generated when omitted. */
  name?: string;
  provider: MachineProvider;
  /** Required iff `provider === "azure"` — omitted for docker/fake, which have no region. */
  region?: string;
  sizeSku: string;
  image: string;
  /** A machine always has exactly one owner, always a person. */
  ownerPersonId: string;
}

/** `orgId`/`actorPersonId` are derived server-side from the caller's session — not sent here. */
export async function createMachine(input: CreateMachineInput): Promise<Machine> {
  const wire = await apiPost<MachineSummaryWire>("/api/v1/machines", input);
  return toMachine(wire);
}

export async function getMachine(machineId: string): Promise<Machine | undefined> {
  const wire = await apiGet<MachineDetailWire>(`/api/v1/machines/${machineId}`).catch(
    () => undefined,
  );
  return wire ? toMachine(wire) : undefined;
}

export async function getMachineManifest(machineId: string): Promise<ManifestEntry[]> {
  const wire = await apiGet<MachineDetailWire>(`/api/v1/machines/${machineId}`);
  return wire.manifest.map(toManifestEntry);
}

export interface MachinePackageEdit {
  packageName: string;
  /** Omit to keep the machine row's current pin rather than clearing it. */
  versionPin?: string | null;
  excluded?: boolean;
}

/**
 * `PATCH /machines/:id/packages` — every machine-scope manifest write goes
 * through here: declaring a package this machine alone needs, changing the
 * version of one inherited from the org, excluding an org package, and
 * dropping a machine row so the org's entry applies again.
 *
 * `pinned` is deliberately never sent. A pin means "cannot be overridden
 * below", and nothing sits below a machine, so it is an org control; the
 * server still rejects a machine edit that collides with an org pin (422,
 * `pinned_entry_conflict`), which is what `ManifestOverrideError` carries.
 */
export async function updateMachinePackages(
  machineId: string,
  edits: { upserts?: MachinePackageEdit[]; removals?: string[] },
): Promise<ManifestEntry[]> {
  try {
    const res = await apiPatch<{ manifest: ResolvedManifestEntryWire[] }>(
      `/api/v1/machines/${machineId}/packages`,
      edits,
    );
    return res.manifest.map(toManifestEntry);
  } catch (err) {
    if (err instanceof ApiError && err.body) {
      throw new ManifestOverrideError(err.body as ApiErrorBody);
    }
    throw err;
  }
}

/**
 * One side of a recorded manifest change. `null` means the package had no
 * entry at that point, so an add reads as `null -> value`.
 */
export interface ManifestHistoryState {
  versionPin: string | null;
  pinned: boolean;
  excluded: boolean;
}

export interface ManifestHistoryEntry {
  id: string;
  occurredAt: string;
  recordedAt: string;
  actorType: AuditActorType;
  actorId: string;
  correlationId: string;
  /** Which scope the edit was made at. Org edits change what this machine resolves too. */
  scope: SettingLevel;
  packageName: string;
  previous: ManifestHistoryState | null;
  current: ManifestHistoryState | null;
}

/**
 * `GET /machines/:id/manifest-history` — every package manifest change that
 * affects this machine, newest first, its own and the org's.
 *
 * Unlike the Activity tab, which filters the org's latest 100 events
 * client-side, this is a server-side query scoped to one machine, so a
 * manifest change can never fall off the page because the org was busy.
 */
export async function getMachineManifestHistory(
  machineId: string,
): Promise<ManifestHistoryEntry[]> {
  const res = await apiGet<{ items: ManifestHistoryEntry[]; nextCursor: string | null }>(
    `/api/v1/machines/${machineId}/manifest-history`,
  );
  return res.items;
}

/**
 * Kept as a thin wrapper over `updateMachinePackages` for the version-override
 * form, which wants the single updated entry back rather than the whole
 * manifest.
 */
export async function overrideManifestEntry(
  machineId: string,
  packageName: string,
  nextVersion: string | null,
): Promise<ManifestEntry> {
  try {
    const res = await apiPatch<{ manifest: ResolvedManifestEntryWire[] }>(
      `/api/v1/machines/${machineId}/packages`,
      { upserts: [{ packageName, versionPin: nextVersion }] },
    );
    const entry = res.manifest.find((e) => e.packageName === packageName);
    if (!entry) {
      throw new ManifestOverrideError({
        error: {
          code: "NOT_FOUND",
          message: `No manifest entry named "${packageName}" on this machine.`,
          requestId: crypto.randomUUID(),
        },
      });
    }
    return toManifestEntry(entry);
  } catch (err) {
    if (err instanceof ApiError && err.body) {
      throw new ManifestOverrideError(err.body as ApiErrorBody);
    }
    throw err;
  }
}

export type UpgradeOutcome = "success" | "rolled_back" | "aborted" | "rollback_failed";

export interface UpgradeResult {
  outcome: UpgradeOutcome;
  previousImage: string;
  currentImage: string;
  targetImage: string;
  nextEligibleAt: string;
  driftUrl?: string;
  failureReason?: string;
}

/**
 * Real `POST /api/v1/machines/:id/upgrade` — the transactional snapshot ->
 * apply -> verify -> rollback-on-failure flow. A non-"success"
 * outcome is not itself a thrown error — it's a legitimate, informative
 * result the caller renders (see `UpgradeMachineDialog`).
 */
/** Which disks the pre-upgrade snapshot captures. "full" copies the OS disk as well as
 * the persistent one; "shallow" copies only the persistent disk, which is where /home
 * lives and the only part an image rebuild cannot recreate. */
export type SnapshotScope = "full" | "shallow";

export async function triggerUpgrade(
  machineId: string,
  targetImage: string,
  snapshotScope: SnapshotScope = "full",
): Promise<UpgradeResult> {
  return apiPost<UpgradeResult>(`/api/v1/machines/${machineId}/upgrade`, {
    targetImage,
    snapshotScope,
  });
}

export interface ArchiveMachineResult {
  machineId: string;
  state: "archived_restorable";
  snapshotId: string;
  retentionExpiresAt: string;
}

/**
 * Real `POST /api/v1/archive/machines/:id/archive` — one-way `live ->
 * archived_restorable` (archived, never deleted). Not itself
 * on the approval-consumer list (`docs/lifecycle.md`), so `approvalId`
 * is omitted here rather than threaded through from the console for
 * attribution.
 */
export async function archiveMachine(machineId: string): Promise<ArchiveMachineResult> {
  return apiPost<ArchiveMachineResult>(`/api/v1/archive/machines/${machineId}/archive`, {});
}

export interface RestartMachineResult {
  machineId: string;
  state: "running";
  restartedAt: string;
}

/**
 * Real `POST /api/v1/machines/:id/restart` — reboots the machine's underlying
 * compute in place (same identity, same declared packages). Only valid for a
 * `"running"` machine; ends any live terminal/SSH session against it.
 */
export async function restartMachine(machineId: string): Promise<RestartMachineResult> {
  return apiPost<RestartMachineResult>(`/api/v1/machines/${machineId}/restart`, {});
}

/**
 * `GET /machines/:id/packages` — the packages table.
 *
 * One row per package across the union of what the manifest allows and what
 * the agent reported is installed, so a package can appear here because
 * someone declared it, because it is on the machine, or both.
 */
export async function getMachinePackages(machineId: string): Promise<MachinePackagesResponse> {
  return apiGet<MachinePackagesResponse>(`/api/v1/machines/${machineId}/packages`);
}

/**
 * `POST /machines/:id/packages/:name/actions` — ask the machine to install or
 * remove one package.
 *
 * Returns as soon as the request is recorded. The agent collects it on its next
 * poll, so the row shows the action as pending until the machine reports back,
 * and `installed` keeps saying whatever the machine last said rather than what
 * was asked for.
 */
export async function createPackageAction(
  machineId: string,
  packageName: string,
  op: PackageActionOp,
): Promise<PendingPackageActionView> {
  try {
    const res = await apiPost<{ action: PendingPackageActionView }>(
      `/api/v1/machines/${machineId}/packages/${encodeURIComponent(packageName)}/actions`,
      { op },
    );
    return res.action;
  } catch (err) {
    if (err instanceof ApiError && err.body) {
      throw new PackageActionError(err.body as ApiErrorBody);
    }
    throw err;
  }
}
