import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiGet, apiPatch } from "@/lib/api-client";
import { CURRENT_ORG_ID } from "@/lib/current-org";

/**
 * Organisation settings — wired to the real `apps/control-plane/src/http/
 * routes/organisation.ts`, an aggregate read/write over settings that
 * already live in (and are governed by) several other real domains:
 * `ApprovalService.ts` (approval mode per action type), `logging/
 * settings.ts` (logging tier, retention location), `domain/archive/
 * org-policy.ts` (default retention days). See that route file's own
 * header comment for why one dedicated endpoint reads/writes all of them
 * rather than the console making four separate calls.
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

/** Matches `logging/settings.ts`'s `RetentionLocation` — the real setting values,
 * not the more verbose names this page's mock previously invented. */
export type RetentionLocation = "customer" | "cloudable_sweden_central";

export interface OrgSettings {
  id: string;
  name: string;
  approvalModes: Record<ApprovalActionType, ApprovalMode>;
  loggingTier: LoggingTier;
  retentionDefaultDays: number;
  retentionLocation: RetentionLocation;
  /** Default Azure region for a new machine that doesn't specify one (docs/spec.md §5) —
   * live-resolved server-side, not a client-side prefill. */
  regionDefault: string;
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
  customer: "Customer-controlled",
  cloudable_sweden_central: "Cloudable-held — Sweden Central",
};

export const organisationKeys = {
  all: ["organisation"] as const,
  settings: () => [...organisationKeys.all, "settings"] as const,
};

/** `options.enabled` defaults to always-on (the Organisation page's own use) — pass
 * `{ enabled: false }` from a caller that only needs this while something else is open
 * (e.g. a dialog), same convention as any other TanStack Query hook here. */
export function useOrgSettings(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: organisationKeys.settings(),
    queryFn: () => apiGet<OrgSettings>(`/api/v1/organisation?orgId=${CURRENT_ORG_ID}`),
    ...options,
  });
}

export type UpdateOrgSettingsInput = Partial<Omit<OrgSettings, "id">>;

export function useUpdateOrgSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateOrgSettingsInput) =>
      apiPatch<OrgSettings>("/api/v1/organisation", {
        orgId: CURRENT_ORG_ID,
        ...input,
        // No auth/identity system yet — same gap as Approvals/Archive. Recorded as
        // a system actor rather than inventing a fake person, since no real one
        // is selected anywhere in this settings UI.
        actor: { type: "system", id: "console" },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: organisationKeys.all });
      toast.success("Organisation settings updated");
    },
    onError: (error) => {
      toast.error("Couldn't update settings", { description: error.message });
    },
  });
}
