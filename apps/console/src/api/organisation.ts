import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { delay } from "./integrations";

/**
 * MOCK DATA LAYER — no backend yet.
 *
 * Mirrors the shape implied by `packages/schema/src/tables/org.ts`,
 * `packages/schema/src/tables/approval.ts` (`mode` enum) and
 * `docs/spec.md` §17 (Logging). `apps/control-plane` has no org-settings
 * HTTP routes in this bootstrap-only fork, so this is an in-memory stand-in.
 * Swap the `queryFn`/`mutationFn` bodies for real `apiGet`/`apiPost` calls
 * once a real endpoint exists — the hook shapes and query keys should not
 * need to change.
 */

/** Matches `approvals.actionType` in packages/schema/src/tables/approval.ts. */
export type ApprovalActionType =
  | "snapshot_restore"
  | "break_glass"
  | "admin_access"
  | "offboarding";

/** Matches `approvals.mode` — see docs/spec.md §13. */
export type ApprovalMode = "none" | "single" | "dual";

/** See docs/spec.md §17. Tier 3 puts Cloudable on the plaintext path — stated, not hidden. */
export type LoggingTier = 1 | 2 | 3;

/** Single org-wide value — no per-machine variant. See docs/spec.md §17. */
export type RetentionLocation = "customer_controlled" | "cloudable_held_sweden_central";

export interface OrgSettings {
  id: string;
  name: string;
  approvalModes: Record<ApprovalActionType, ApprovalMode>;
  loggingTier: LoggingTier;
  retentionDefaultDays: number;
  retentionLocation: RetentionLocation;
}

export const APPROVAL_ACTION_TYPES: ApprovalActionType[] = [
  "snapshot_restore",
  "break_glass",
  "admin_access",
  "offboarding",
];

export const APPROVAL_ACTION_LABELS: Record<ApprovalActionType, string> = {
  snapshot_restore: "Snapshot restore",
  break_glass: "Break-glass access",
  admin_access: "Admin access to an unowned machine",
  offboarding: "Offboarding",
};

export const LOGGING_TIER_LABELS: Record<LoggingTier, string> = {
  1: "Tier 1 — metadata only",
  2: "Tier 2 — session-level",
  3: "Tier 3 — full command capture",
};

export const RETENTION_LOCATION_LABELS: Record<RetentionLocation, string> = {
  customer_controlled: "Customer-controlled",
  cloudable_held_sweden_central: "Cloudable-held — Sweden Central",
};

let mockOrgSettings: OrgSettings = {
  id: "org-1",
  name: "Normain",
  approvalModes: {
    snapshot_restore: "single",
    break_glass: "dual",
    admin_access: "dual",
    offboarding: "single",
  },
  loggingTier: 2,
  retentionDefaultDays: 30,
  retentionLocation: "cloudable_held_sweden_central",
};

export const organisationKeys = {
  all: ["organisation"] as const,
  settings: () => [...organisationKeys.all, "settings"] as const,
};

export function useOrgSettings() {
  return useQuery({
    queryKey: organisationKeys.settings(),
    queryFn: () => delay(mockOrgSettings),
  });
}

export type UpdateOrgSettingsInput = Partial<Omit<OrgSettings, "id">>;

export function useUpdateOrgSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateOrgSettingsInput) => {
      mockOrgSettings = {
        ...mockOrgSettings,
        ...input,
        approvalModes: { ...mockOrgSettings.approvalModes, ...input.approvalModes },
      };
      return delay(mockOrgSettings);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: organisationKeys.all }),
  });
}
