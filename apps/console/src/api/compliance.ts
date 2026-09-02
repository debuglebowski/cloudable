import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { auditKeys } from "@/api/audit";
import { apiGet, apiPatch } from "@/lib/api-client";
import { CURRENT_ORG_ID } from "@/lib/current-org";

/**
 * Compliance control map — wired to the real `apps/control-plane/src/http/
 * routes/compliance.ts`. `computeControlMap` (`control-map.ts`) derives
 * each control's DEFAULT status purely from which compliance checks are
 * currently registered; `useSetControlOverride` below layers this org's
 * explicit choice on top of that default without replacing it
 * ("organisation-level configuration, overridable per control...
 * customers adjust for their own framework or auditor").
 */

export type ControlStatus = "implemented" | "manual_action_required" | "not_covered";

export interface ControlMapEntry {
  id: string;
  label: string;
  framework: string;
  status: ControlStatus;
  evidencedByCheckIds: string[];
  /** True when `status` is this org's explicit override, not the computed default. */
  overridden: boolean;
  /** True when this control can be overridden at all — false for a structurally
   * out-of-scope control (e.g. HR screening); the backend always rejects an override
   * attempt for one of those, so the page hides the action rather than offering it. */
  overridable: boolean;
}

export const CONTROL_STATUSES: ControlStatus[] = [
  "implemented",
  "manual_action_required",
  "not_covered",
];

export const CONTROL_STATUS_LABELS: Record<ControlStatus, string> = {
  implemented: "Implemented",
  manual_action_required: "Manual action required",
  not_covered: "Not covered",
};

export const complianceKeys = {
  all: ["compliance"] as const,
  controlMap: () => [...complianceKeys.all, "control-map"] as const,
};

export function useControlMap() {
  return useQuery({
    queryKey: complianceKeys.controlMap(),
    queryFn: () =>
      apiGet<{ controls: ControlMapEntry[] }>(
        `/api/v1/compliance/control-map?orgId=${CURRENT_ORG_ID}`,
      ),
  });
}

export interface SetControlOverrideInput {
  controlId: string;
  /** `null` clears the override, reverting the control to its computed default. */
  status: ControlStatus | null;
}

export function useSetControlOverride() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ controlId, status }: SetControlOverrideInput) =>
      apiPatch<{ controls: ControlMapEntry[] }>(
        `/api/v1/compliance/control-map/${controlId}/override`,
        { orgId: CURRENT_ORG_ID, status },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: complianceKeys.all });
      // The Audit page's evidence view (`useControlEvidence` in `@/api/audit`) hits this
      // same `/api/v1/compliance/control-map` endpoint under its own query key, not
      // `complianceKeys` — without this, an override made here would sit stale there
      // until that separate cache entry happened to expire on its own.
      queryClient.invalidateQueries({ queryKey: auditKeys.evidence() });
      toast.success("Control override updated");
    },
    onError: (error) => {
      toast.error("Couldn't update control override", { description: error.message });
    },
  });
}
