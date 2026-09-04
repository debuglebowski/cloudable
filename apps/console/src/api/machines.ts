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
  /** Count of machines that override this entry below the level shown here. No real endpoint
   * aggregates this yet (see `getMachineManifest` below) — always undefined against real data. */
  overriddenBelow?: number;
}

export type DriftStatus = "clean" | "detected" | "unknown";

/**
 * Shaped after `machine.drift_detected`'s payload in
 * `packages/events/src/domains/machine.ts` (`{ undeclaredPackages, undeclaredPorts }`).
 * `status: "unknown"` is distinct from `"clean"` — it means no drift event data exists
 * yet for this machine (never reconciled, or currently stopped), not that drift was
 * checked and found absent.
 *
 * NO real endpoint surfaces this today: drift is an *event* (`machine.drift_detected`),
 * not a queryable machine field, and no unit built a "current drift status per machine"
 * projection over that event stream. `getMachineDrift` below always returns `unknown`
 * against the real backend rather than fabricating a plausible-looking clean/detected
 * value — flagged as a real gap, not silently faked.
 */
export interface DriftInfo {
  status: DriftStatus;
  undeclaredPackages?: string[];
  undeclaredPorts?: number[];
  detectedAt?: string;
}

export class ManifestOverrideError extends Error {
  readonly body: ApiErrorBody;
  constructor(body: ApiErrorBody) {
    super(body.error.message);
    this.name = "ManifestOverrideError";
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
  drift: (machineId: string) => [...machinesKeys.all, "drift", machineId] as const,
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
  };
}

export async function listMachines(): Promise<Machine[]> {
  const res = await apiGet<{ items: MachineSummaryWire[] }>("/api/v1/machines");
  return res.items.map(toMachine);
}

export interface CreateMachineInput {
  name: string;
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

export async function getMachineDrift(_machineId: string): Promise<DriftInfo> {
  // See the DriftInfo doc comment above — there is no real endpoint for this yet.
  return { status: "unknown" };
}

/**
 * `PATCH /machines/:id/packages` — writes a machine-scoped override. Real
 * server-side enforcement of "pinned entries cannot be overridden below"
 * (returns a 422 with `code: "pinned_entry_conflict"`), same
 * validation-error-at-edit-time behavior the mock used to simulate by hand.
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
export async function triggerUpgrade(
  machineId: string,
  targetImage: string,
): Promise<UpgradeResult> {
  return apiPost<UpgradeResult>(`/api/v1/machines/${machineId}/upgrade`, { targetImage });
}

export interface ReconcileResult {
  machineId: string;
  desiredStateVersion: number;
}

/**
 * Real `POST /api/v1/config/machines/:id/reconcile` — the ONLY operation
 * that mutates a live machine; editing desired state elsewhere
 * is always inert until this runs. `confirm: true` is required — the
 * server rejects both an absent and an explicit `false` with the same
 * confirmation-gate error, so there's nothing to send otherwise.
 */
export async function triggerReconcile(machineId: string): Promise<ReconcileResult> {
  return apiPost<ReconcileResult>(`/api/v1/config/machines/${machineId}/reconcile`, {
    confirm: true,
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
