import type { SettingRow } from "@cloudable/schema";
import { resolveSetting } from "@cloudable/schema";
import { config } from "../../config";
import type { AdminAccessPolicy, ApprovalMode, ElevationLevel } from "./types";

/** Org policy for an admin connecting to a machine they do not own. Resolved via `resolveSetting`. */
export const ADMIN_ACCESS_POLICY_SETTING_KEY = "admin_access_policy";

/**
 * The approval mode (none/single/dual) the org has generically
 * configured for `admin_access`-type approvals. This function resolves it
 * itself (rather than relying on `ApprovalService` to expose it) because
 * `ApprovalService.request()`'s interface (owned by unit 5) has no `mode`
 * input or output — see `requiredApprovalModeFloor` below for why that
 * matters.
 */
export const ADMIN_ACCESS_APPROVAL_MODE_SETTING_KEY = "admin_access_approval_mode";

/** Minutes a granted elevation stays live before it must be re-requested. Org-configurable. */
export const ADMIN_ACCESS_ELEVATION_TTL_MINUTES_SETTING_KEY = "admin_access_elevation_ttl_minutes";

/** What `ADMIN_ACCESS_POLICY` means when unset: admins get no live access to someone else's machine. */
export const DEFAULT_ADMIN_ACCESS_POLICY: AdminAccessPolicy = "never";

export const DEFAULT_APPROVAL_MODE: ApprovalMode = "single";

/** A time-boxed grant (e.g. 1h). */
export const DEFAULT_ELEVATION_TTL_MINUTES = 60;

const APPROVAL_MODE_RANK: Record<ApprovalMode, number> = { none: 0, single: 1, dual: 2 };

export function approvalModeSatisfiesFloor(configured: ApprovalMode, floor: ApprovalMode): boolean {
  return APPROVAL_MODE_RANK[configured] >= APPROVAL_MODE_RANK[floor];
}

/**
 * Two elevation levels, two approval requirements. `shell` can
 * read live injected secrets on a machine, so — mirroring the
 * restore flow's
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

/**
 * The admin-access policy in force. It comes from deployment config (`ADMIN_ACCESS_POLICY`,
 * default `never`), not from settings: an `admin_access_policy` setting row, if one exists from
 * before the pin, is ignored, and the API refuses to write a new one. `rows` and `chain` stay in
 * the signature so callers keep asking the question the same way.
 */
export function resolveAdminAccessPolicy(
  _rows: ReadonlyArray<SettingRow<unknown>>,
  _chain: SettingsChain,
): AdminAccessPolicy {
  return config.adminAccessPolicy;
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
