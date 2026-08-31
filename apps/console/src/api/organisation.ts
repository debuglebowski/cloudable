import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { machinesKeys } from "@/api/machines";
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
  packages: () => [...organisationKeys.all, "packages"] as const,
};

export function useOrgSettings() {
  return useQuery({
    queryKey: organisationKeys.settings(),
    queryFn: () => apiGet<OrgSettings>(`/api/v1/organisation?orgId=${CURRENT_ORG_ID}`),
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

/**
 * Org-scope package manifest entries — `PATCH /api/v1/organisation/packages`
 * (`apps/control-plane/src/http/routes/organisation.ts`), the org-scope
 * sibling of `overrideManifestEntry` (`@/api/machines`), which only ever
 * writes machine-scoped rows. These are the entries that become the
 * resolved default on any machine with neither its own entry nor an
 * override for that package name (docs/inheritance.md, spec.md §6).
 */
export interface OrgPackageEntry {
  packageName: string;
  /** `null` means "any" version — no pin. */
  versionPin: string | null;
  /** Cannot be overridden below the org scope (spec §6) once set. */
  pinned: boolean;
}

export interface OrgPackageEdit {
  packageName: string;
  versionPin?: string | null;
  pinned?: boolean;
}

// No auth/identity system yet — same system-actor gap as `useUpdateOrgSettings` above.
const CONSOLE_ACTOR = { type: "system" as const, id: "console" };

export function useOrgPackages() {
  return useQuery({
    queryKey: organisationKeys.packages(),
    queryFn: () =>
      apiGet<{ items: OrgPackageEntry[] }>(
        `/api/v1/organisation/packages?orgId=${CURRENT_ORG_ID}`,
      ).then((res) => res.items),
  });
}

/**
 * An org-scope package edit changes what every machine without its own
 * entry/override resolves to (docs/inheritance.md), so a machine detail
 * page's already-cached resolved manifest (`machinesKeys.manifest`) is
 * invalidated alongside the org's own package list — otherwise a machine
 * detail page opened before this edit would keep showing the stale
 * org-level default for up to the query client's `staleTime`.
 */
function invalidateOrgPackages(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: organisationKeys.packages() });
  queryClient.invalidateQueries({ queryKey: machinesKeys.all });
}

export function useAddOrgPackage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (edit: OrgPackageEdit) =>
      apiPatch<{ items: OrgPackageEntry[] }>("/api/v1/organisation/packages", {
        orgId: CURRENT_ORG_ID,
        upserts: [edit],
        actor: CONSOLE_ACTOR,
      }),
    onSuccess: () => {
      invalidateOrgPackages(queryClient);
      toast.success("Package added to the org default manifest");
    },
    onError: (error) => {
      toast.error("Couldn't add package", { description: error.message });
    },
  });
}

export function useRemoveOrgPackage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (packageName: string) =>
      apiPatch<{ items: OrgPackageEntry[] }>("/api/v1/organisation/packages", {
        orgId: CURRENT_ORG_ID,
        removals: [packageName],
        actor: CONSOLE_ACTOR,
      }),
    onSuccess: () => {
      invalidateOrgPackages(queryClient);
      toast.success("Package removed from the org default manifest");
    },
    onError: (error) => {
      toast.error("Couldn't remove package", { description: error.message });
    },
  });
}
