import type { ApiErrorBody, PackageEnsureApprovalView, PackageSetting } from "@cloudable/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ApiError, apiGet, apiPatch, apiPost, refusalReason } from "@/lib/api-client";

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
  | "offboarding"
  | "package_install"
  | "package_ensure";

/** Matches `approvals.mode`. */
export type ApprovalMode = "none" | "single" | "dual";

export type LoggingTier = 1 | 2;

/** Matches `logging/settings.ts`'s `RetentionLocation` — the real setting values,
 * not the more verbose names this page's mock previously invented. */
export type RetentionLocation = "customer" | "cloudable_sweden_central";

export interface OrgSettings {
  id: string;
  name: string;
  approvalModes: Record<ApprovalActionType, ApprovalMode>;
  loggingTier: LoggingTier;
  /** How many of this org's machines have their own logging-tier override — read-only,
   * feeds `LineageGutter`'s "N machines override this" badge. Not sent on update. */
  loggingTierOverrideCount: number;
  /** How long a snapshot's volume data is kept. */
  retentionDefaultDays: number;
  /** How long events are kept before the retention sweep deletes them. */
  eventRetentionDays: number;
  retentionLocation: RetentionLocation;
  /** Hours before an Ensure install that failed is tried again. Whole hours, 1 to 720. */
  ensureRetryHours: number;
  /** The nixpkgs commit `nix:` packages install from. Null until an admin sets one. */
  nixSnapshot: string | null;
}

export const ENSURE_RETRY_HOURS_MIN = 1;
export const ENSURE_RETRY_HOURS_MAX = 720;
export const ENSURE_RETRY_HOURS_DEFAULT = 24;

export const APPROVAL_ACTION_TYPES: ApprovalActionType[] = [
  "snapshot_restore",
  "break_glass",
  "admin_access",
  "offboarding",
  "package_install",
  "package_ensure",
];

export const APPROVAL_ACTION_LABELS: Record<ApprovalActionType, string> = {
  snapshot_restore: "Snapshot restore",
  break_glass: "Break-glass access",
  admin_access: "Admin access to an unowned machine",
  offboarding: "Offboarding",
  package_install: "Package install",
  package_ensure: "Setting a package to Ensure",
};

export const LOGGING_TIER_LABELS: Record<LoggingTier, string> = {
  1: "Tier 1 — metadata only",
  2: "Tier 2 — session-level",
};

export const RETENTION_LOCATION_LABELS: Record<RetentionLocation, string> = {
  customer: "Customer-controlled",
  cloudable_sweden_central: "Cloudable-held — Sweden Central",
};

export const organisationKeys = {
  all: ["organisation"] as const,
  settings: () => [...organisationKeys.all, "settings"] as const,
  packages: () => [...organisationKeys.all, "packages"] as const,
};

/** Matches `domain/organisation/packages.ts`'s `OrgPackageEntry` on the control-plane. */
export interface OrgPackageEntry {
  packageName: string;
  versionPin: string | null;
  locked: boolean;
  /** The declared parent this package is part of, or null. */
  partOf?: string | null;
  /** Why it is allowed, or null. */
  description?: string | null;
  /** What Cloudable does about it on every machine it reaches. */
  setting: PackageSetting;
}

export interface OrgPackageEdit {
  packageName: string;
  versionPin?: string | null;
  locked?: boolean;
  partOf?: string | null;
  description?: string | null;
  /** Omitted keeps it. Moving to an ensure setting waits for an approval. */
  setting?: PackageSetting;
}

interface OrgPackagesResponse {
  items: OrgPackageEntry[];
}

export interface UpdateOrgPackagesResult extends OrgPackagesResponse {
  /** One per edit that set an ensure setting. `approved` means it was applied already. */
  ensureApprovals?: PackageEnsureApprovalView[];
}

/** The control plane's own message for a refused edit (a lock conflict, an ensure setting it cannot take). */
function editErrorMessage(error: Error): string {
  if (error instanceof ApiError && error.body && typeof error.body === "object") {
    const message = (error.body as Partial<ApiErrorBody>).error?.message;
    if (typeof message === "string") return message;
  }
  return refusalReason(error) ?? error.message;
}

export function useOrgSettings() {
  return useQuery({
    queryKey: organisationKeys.settings(),
    queryFn: () => apiGet<OrgSettings>("/api/v1/organisation"),
  });
}

// `loggingTierOverrideCount` is derived (a count over machines' own
// settings), never something the org PATCH endpoint accepts. Neither are approval modes:
// those change only with an approver's sign-off, through `useRequestApprovalModesChange`.
export type UpdateOrgSettingsInput = Partial<
  Omit<OrgSettings, "id" | "loggingTierOverrideCount" | "approvalModes">
>;

export function useUpdateOrgSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateOrgSettingsInput) =>
      apiPatch<OrgSettings>("/api/v1/organisation", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: organisationKeys.all });
      toast.success("Organisation settings updated");
    },
    onError: (error) => {
      toast.error("Couldn't update settings", {
        description: refusalReason(error) ?? error.message,
      });
    },
  });
}

/**
 * `POST /api/v1/organisation/approval-modes`. Nothing changes yet: the control plane records a
 * request, and the new modes apply once an approver signs it off on the Approvals page.
 */
export function useRequestApprovalModesChange() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      approvalModes: Partial<Record<ApprovalActionType, ApprovalMode>>;
      reason: string;
    }) => apiPost<{ id: string; status: string }>("/api/v1/organisation/approval-modes", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
      toast.success("Change requested", {
        description: "An approver must sign it off before it applies.",
        action: {
          label: "Approvals",
          onClick: () => {
            window.location.href = "/approvals";
          },
        },
      });
    },
    onError: (error) => {
      toast.error("Couldn't request the change", {
        description: refusalReason(error) ?? error.message,
      });
    },
  });
}

/**
 * Org-scope package manifest — wired to `PATCH /api/v1/organisation/packages`
 * (`http/routes/organisation.ts`), the sibling of the machine-detail page's
 * manifest editor but for `org`-scoped rows: the only place that creates or
 * removes an org-scoped entry, rather than only overriding an
 * already-resolved one (see `domain/organisation/packages.ts`).
 */
export function useOrgPackages(options: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: organisationKeys.packages(),
    queryFn: () =>
      apiGet<OrgPackagesResponse>("/api/v1/organisation/packages").then((res) => res.items),
  });
}

/**
 * Writes org package edits directly, for callers that show their own errors (the
 * add/edit dialog). A refusal comes back as an Error carrying the server's own message.
 */
export async function updateOrgPackages(input: {
  upserts?: OrgPackageEdit[];
  removals?: string[];
}): Promise<UpdateOrgPackagesResult> {
  try {
    return await apiPatch<UpdateOrgPackagesResult>("/api/v1/organisation/packages", input);
  } catch (error) {
    throw error instanceof Error ? new Error(editErrorMessage(error)) : error;
  }
}

function useUpdateOrgPackages() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { upserts?: OrgPackageEdit[]; removals?: string[] }) =>
      apiPatch<UpdateOrgPackagesResult>("/api/v1/organisation/packages", input),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: organisationKeys.packages() });
      if (result.ensureApprovals?.some((approval) => approval.status === "pending")) {
        queryClient.invalidateQueries({ queryKey: ["approvals"] });
      }
    },
    onError: (error) => {
      toast.error("Couldn't update the org package manifest", {
        description: editErrorMessage(error),
      });
    },
  });
}

/** Changes one org entry's setting, keeping everything else about it. */
export function useSetOrgPackageSetting() {
  const update = useUpdateOrgPackages();
  return {
    ...update,
    mutate: (
      input: { packageName: string; setting: PackageSetting },
      options?: Parameters<typeof update.mutate>[1],
    ) => update.mutate({ upserts: [input] }, options),
  };
}

export function useRemoveOrgPackage() {
  const update = useUpdateOrgPackages();
  return {
    ...update,
    mutate: (packageName: string, options?: Parameters<typeof update.mutate>[1]) =>
      update.mutate({ removals: [packageName] }, options),
  };
}
