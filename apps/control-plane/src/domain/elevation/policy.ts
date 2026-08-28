import type { SettingRow } from "@cloudable/schema";
import { resolveSetting } from "@cloudable/schema";
import type { AdminAccessPolicy, ApprovalMode, ElevationLevel } from "./types";

/** Org policy for an admin connecting to a machine they do not own (spec §15). Resolved via `resolveSetting`. */
export const ADMIN_ACCESS_POLICY_SETTING_KEY = "admin_access_policy";

/**
 * The approval mode (spec §13: none/single/dual) the org has generically
 * configured for `admin_access`-type approvals. This unit resolves it
 * itself (rather than relying on `ApprovalService` to expose it) because
 * `ApprovalService.request()`'s interface (owned by unit 5) has no `mode`
 * input or output — see `requiredApprovalModeFloor` below for why that
 * matters.
 */
export const ADMIN_ACCESS_APPROVAL_MODE_SETTING_KEY = "admin_access_approval_mode";

/** Minutes a granted elevation stays live before it must be re-requested. Org-configurable. */
export const ADMIN_ACCESS_ELEVATION_TTL_MINUTES_SETTING_KEY = "admin_access_elevation_ttl_minutes";

/** Fail-safe default: unset means "go through approval", not "wide open" or "fully blocked". */
export const DEFAULT_ADMIN_ACCESS_POLICY: AdminAccessPolicy = "with_approval";

export const DEFAULT_APPROVAL_MODE: ApprovalMode = "single";

/** Spec §15: "time-boxed grant (e.g. 1h)". */
export const DEFAULT_ELEVATION_TTL_MINUTES = 60;

const APPROVAL_MODE_RANK: Record<ApprovalMode, number> = { none: 0, single: 1, dual: 2 };

export function approvalModeSatisfiesFloor(configured: ApprovalMode, floor: ApprovalMode): boolean {
  return APPROVAL_MODE_RANK[configured] >= APPROVAL_MODE_RANK[floor];
}

/**
 * Two elevation levels, two approval requirements (spec §15). `shell` can
 * read live injected secrets on a machine, so — mirroring unit 15's
 * escalating restore-mode design, where "full restore including secret
 * bindings" is "deliberately hardest to reach" — it must never settle for
 * less than dual control. `file_recovery` is lower risk and may proceed at
 * the org's configured mode, floored at `single` once `with_approval` is in
 * effect at all.
 *
 * `ApprovalService.request()`'s interface (owned by unit 5) takes no `mode`
 * override, so this unit cannot force its own resolved mode through that
 * call. Instead, `requestElevation` checks the org's *configured*
 * `admin_access_approval_mode` against this floor *before* calling
 * `ApprovalService`, and refuses the request outright if the org hasn't
 * configured the mode strictly enough for the level requested — i.e. shell
 * elevation never proceeds at less than dual control, because it simply
 * won't proceed at all otherwise. When unit 5's `ApprovalService` grows a
 * way to accept a required-mode override, that pre-check can be replaced
 * with passing `requiredApprovalModeFloor(level)` straight through.
 */
export function requiredApprovalModeFloor(level: ElevationLevel): ApprovalMode {
  return level === "shell" ? "dual" : "single";
}

export interface SettingsChain {
  orgId: string;
  templateId?: string | null;
  machineId: string;
}

export function resolveAdminAccessPolicy(
  rows: ReadonlyArray<SettingRow<unknown>>,
  chain: SettingsChain,
): AdminAccessPolicy {
  const resolved = resolveSetting<AdminAccessPolicy>(
    ADMIN_ACCESS_POLICY_SETTING_KEY,
    rows as unknown as ReadonlyArray<SettingRow<AdminAccessPolicy>>,
    chain,
  );
  return resolved?.value ?? DEFAULT_ADMIN_ACCESS_POLICY;
}

export function resolveAdminAccessApprovalMode(
  rows: ReadonlyArray<SettingRow<unknown>>,
  chain: SettingsChain,
): ApprovalMode {
  const resolved = resolveSetting<ApprovalMode>(
    ADMIN_ACCESS_APPROVAL_MODE_SETTING_KEY,
    rows as unknown as ReadonlyArray<SettingRow<ApprovalMode>>,
    chain,
  );
  return resolved?.value ?? DEFAULT_APPROVAL_MODE;
}

export function resolveElevationTtlMinutes(
  rows: ReadonlyArray<SettingRow<unknown>>,
  chain: SettingsChain,
): number {
  const resolved = resolveSetting<number>(
    ADMIN_ACCESS_ELEVATION_TTL_MINUTES_SETTING_KEY,
    rows as unknown as ReadonlyArray<SettingRow<number>>,
    chain,
  );
  return resolved?.value ?? DEFAULT_ELEVATION_TTL_MINUTES;
}
