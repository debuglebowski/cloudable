import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiPost } from "@/lib/api-client";
import { machinesKeys } from "./machines";
import { peopleKeys } from "./people";

/**
 * Real `POST /api/v1/offboarding` (spec §14: revoke live certificates, stop
 * every owned machine, clear ownership, archive each machine starting its
 * retention clock). `personId` is the only body field the server still
 * trusts — `requestedByPersonId` is derived from the caller's session (see
 * `apps/control-plane/src/http/middleware/auth.ts`).
 *
 * Deliberately does NOT also deactivate the person: the real backend
 * doesn't touch `people.active` as part of this flow (only certs/machines),
 * so this layer doesn't invent that behavior either — see
 * `OffboardPersonDialog`'s own copy, which says so.
 */

export type OffboardApprovalStatus = "approved" | "pending" | "rejected" | "expired";

export interface OffboardPersonResult {
  approvalId: string;
  status: OffboardApprovalStatus;
  machinesOffboarded: string[];
  machineFailures: { machineId: string; reason: string }[];
}

export interface OffboardPersonInput {
  personId: string;
  reason: string;
}

async function offboardPerson(input: OffboardPersonInput): Promise<OffboardPersonResult> {
  return apiPost<OffboardPersonResult>("/api/v1/offboarding", {
    personId: input.personId,
    reason: input.reason,
  });
}

export function useOffboardPersonMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: offboardPerson,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: peopleKeys.list() });
      void queryClient.invalidateQueries({ queryKey: machinesKeys.lists() });
    },
  });
}

/**
 * `POST /api/v1/offboarding/:approvalId/sync` — resumes a `"pending"` offboarding
 * (single/dual approval mode) once its approval has since been decided elsewhere
 * (the Approvals page). There's no push from that decision back to this dialog —
 * same "check again" shape the Access page already uses for elevations — so this
 * is what a re-opened dialog, or a "Check again" button, calls to pick up where
 * the original request left off. Safe to call repeatedly: still pending returns
 * unchanged, already-resumed finds nothing left to do.
 */
async function syncOffboarding(approvalId: string): Promise<OffboardPersonResult> {
  return apiPost<OffboardPersonResult>(`/api/v1/offboarding/${approvalId}/sync`);
}

export function useSyncOffboardingMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: syncOffboarding,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: peopleKeys.list() });
      void queryClient.invalidateQueries({ queryKey: machinesKeys.lists() });
    },
  });
}
