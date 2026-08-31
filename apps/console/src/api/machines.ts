import type { LoggingTier } from "@/api/organisation";
import { ApiError, apiGet, apiPatch, apiPost } from "@/lib/api-client";
import { CURRENT_ORG_ID } from "@/lib/current-org";
import {
  type ApiErrorBody,
  LOGGING_TIER_SETTING_KEY,
  type PatchSettingResponse,
} from "@cloudable/contracts";

export type MachineState =
  | "provisioning"
  | "running"
  | "stopped"
  | "archived_restorable"
  | "archived_expired"
  | "error";

export interface Machine {
  id: string;
  orgId: string;
  templateId: string | null;
  ownerPersonId: string | null;
  name: string;
  region: string;
  sizeSku: string;
  image: string;
  state: MachineState;
  lastVerifiedAt: string | null;
  archivedAt: string | null;
}

export type SettingLevel = "org" | "template" | "machine";

export interface ManifestEntry {
  package: string;
  /** `null` means "any" version — no pin. */
  version: string | null;
  source: SettingLevel;
  /** Org-level pin: cannot be overridden below (spec §6). */
  pinned: boolean;
  /** Count of machines that override this entry below the level shown here. No real endpoint
   * aggregates this yet (see `getMachineManifest` below) — always undefined against real data. */
  overriddenBelow?: number;
}

/** spec.md §7/§11: which of the two access methods are turned on for a machine. */
export interface AccessMethodsEnabled {
  webTerminal: boolean;
  ssh: boolean;
}

/** A resolved org → machine setting, lowest level wins — the shared shape `persistentPaths`
 * and `accessMethodsEnabled` both come back as (see `@cloudable/contracts`'s `MachineDetail`). */
export interface ResolvedMachineSetting<T> {
  value: T;
  source: SettingLevel;
}

/**
 * Written via the generic `PATCH /api/v1/config/settings` endpoint
 * (`apps/control-plane/src/http/routes/config.ts`) rather than a
 * dedicated machines endpoint — same shared write path as the Git-sourced
 * config import (docs/spec.md §16), which is also what lets disabling web
 * terminal terminate live sessions no matter which UI/API entry point the
 * change came through (spec §11.1). Keep these two literals in sync with
 * `PERSISTENT_PATHS_KEY`/`ACCESS_METHODS_ENABLED_KEY` in
 * `apps/control-plane/src/domain/machine/settings.ts`.
 */
const PERSISTENT_PATHS_SETTING_KEY = "machine.persistentPaths";
const ACCESS_METHODS_ENABLED_SETTING_KEY = "machine.accessMethodsEnabled";

/**
 * The logging tier resolved for one specific machine — its own machine-
 * scoped override if it has one, else the org default (spec §17,
 * `resolveSetting()`'s org → machine chain — see
 * `apps/control-plane/src/logging/settings.ts`'s `getEffectiveLoggingTier`).
 */
export interface MachineLoggingTier {
  tier: LoggingTier;
  source: SettingLevel;
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
  persistentPaths: (machineId: string) =>
    [...machinesKeys.all, "persistentPaths", machineId] as const,
  accessMethodsEnabled: (machineId: string) =>
    [...machinesKeys.all, "accessMethodsEnabled", machineId] as const,
  loggingTier: (machineId: string) => [...machinesKeys.all, "loggingTier", machineId] as const,
};

interface MachineSummaryWire {
  id: string;
  orgId: string;
  templateId: string | null;
  ownerPersonId: string | null;
  name: string;
  region: string;
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

interface ResolvedMachineSettingWire<T> {
  value: T;
  source: SettingLevel;
  resolvedFromScopeId: string;
}

interface MachineDetailWire extends MachineSummaryWire {
  manifest: ResolvedManifestEntryWire[];
  persistentPaths: ResolvedMachineSettingWire<string[]>;
  accessMethodsEnabled: ResolvedMachineSettingWire<AccessMethodsEnabled>;
  loggingTier: MachineLoggingTier;
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
  const res = await apiGet<{ items: MachineSummaryWire[] }>(
    `/api/v1/machines?orgId=${CURRENT_ORG_ID}`,
  );
  return res.items.map(toMachine);
}

export interface CreateMachineInput {
  name: string;
  /** Omitted — the control plane resolves the org's configured default region
   * (docs/spec.md §5) instead of the console prefilling one. */
  region?: string;
  sizeSku: string;
  image: string;
  /** A machine always has exactly one owner, always a person (CLAUDE.md invariant #3). */
  ownerPersonId: string;
}

export async function createMachine(input: CreateMachineInput): Promise<Machine> {
  const wire = await apiPost<MachineSummaryWire>("/api/v1/machines", {
    orgId: CURRENT_ORG_ID,
    ...input,
  });
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

export async function getMachineLoggingTier(machineId: string): Promise<MachineLoggingTier> {
  const wire = await apiGet<MachineDetailWire>(`/api/v1/machines/${machineId}`);
  return wire.loggingTier;
}

/**
 * Writes a machine-scoped `logging_tier` override through the generic
 * config editor endpoint (`PATCH /api/v1/config/settings`,
 * `apps/control-plane/src/domain/config/apply-setting-change.ts`) — the
 * same "same path whether UI or Git" mechanism every other chain-resolved
 * setting uses (docs/spec.md §16), not a dedicated logging-tier endpoint.
 */
export async function overrideMachineLoggingTier(
  machineId: string,
  tier: LoggingTier,
): Promise<void> {
  await apiPatch<PatchSettingResponse>("/api/v1/config/settings", {
    orgId: CURRENT_ORG_ID,
    scopeType: "machine",
    scopeId: machineId,
    key: LOGGING_TIER_SETTING_KEY,
    value: tier,
    // No auth/identity system yet — same gap as Organisation settings (see
    // `api/organisation.ts`'s `useUpdateOrgSettings`).
    actor: { type: "system", id: "console" },
  });
}

export async function getMachineDrift(_machineId: string): Promise<DriftInfo> {
  // See the DriftInfo doc comment above — there is no real endpoint for this yet.
  return { status: "unknown" };
}

export async function getMachinePersistentPaths(
  machineId: string,
): Promise<ResolvedMachineSetting<string[]>> {
  const wire = await apiGet<MachineDetailWire>(`/api/v1/machines/${machineId}`);
  return { value: wire.persistentPaths.value, source: wire.persistentPaths.source };
}

export async function getMachineAccessMethodsEnabled(
  machineId: string,
): Promise<ResolvedMachineSetting<AccessMethodsEnabled>> {
  const wire = await apiGet<MachineDetailWire>(`/api/v1/machines/${machineId}`);
  return { value: wire.accessMethodsEnabled.value, source: wire.accessMethodsEnabled.source };
}

/**
 * `PATCH /api/v1/config/settings` at `scopeType: "machine"` — always writes (and always
 * resolves to) a machine-level override, so the result's `source` is trivially "machine"
 * without needing to re-fetch and re-resolve the chain.
 */
export async function overridePersistentPaths(
  machineId: string,
  paths: string[],
): Promise<ResolvedMachineSetting<string[]>> {
  const res = await apiPatch<{ setting: { current: string[] } }>("/api/v1/config/settings", {
    orgId: CURRENT_ORG_ID,
    scopeType: "machine",
    scopeId: machineId,
    key: PERSISTENT_PATHS_SETTING_KEY,
    value: paths,
    // No auth/identity system yet — same gap as Approvals/Archive/Organisation (see
    // `api/organisation.ts`'s identical comment) — recorded as a system actor.
    actor: { type: "system", id: "console" },
  });
  return { value: res.setting.current, source: "machine" };
}

export async function overrideAccessMethodsEnabled(
  machineId: string,
  next: AccessMethodsEnabled,
): Promise<ResolvedMachineSetting<AccessMethodsEnabled>> {
  const res = await apiPatch<{ setting: { current: AccessMethodsEnabled } }>(
    "/api/v1/config/settings",
    {
      orgId: CURRENT_ORG_ID,
      scopeType: "machine",
      scopeId: machineId,
      key: ACCESS_METHODS_ENABLED_SETTING_KEY,
      value: next,
      actor: { type: "system", id: "console" },
    },
  );
  return { value: res.setting.current, source: "machine" };
}

/**
 * `PATCH /machines/:id/packages` — writes a machine-scoped override. Real
 * server-side enforcement of spec §6's "pinned entries cannot be overridden
 * below" (returns a 422 with `code: "pinned_entry_conflict"`), same
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
