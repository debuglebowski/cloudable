import type {
  ApiErrorBody,
  CreateProfileRequest,
  PackageEnsureApprovalView,
  ProfileDetail,
  ProfileSummary,
  UpdateProfileRequest,
} from "@cloudable/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, apiGet, apiPatch, apiPost, apiPut, refusalReason } from "@/lib/api-client";

import type { OrgPackageEdit, OrgPackageEntry } from "./organisation";

/**
 * Profiles: named sets of settings machines link to (org → profile → machine).
 * Wired to `apps/control-plane/src/http/routes/profiles.ts`. A profile's settings
 * are written through `PATCH /api/v1/config/settings` with `scopeType: "profile"`.
 */

export type { ProfileDetail, ProfileSummary };

export const profileKeys = {
  all: ["profiles"] as const,
  list: () => [...profileKeys.all, "list"] as const,
  detail: (id: string) => [...profileKeys.all, "detail", id] as const,
};

/** The control plane's own words for a refused edit. */
export function profileErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.body && typeof error.body === "object") {
    const body = error.body as Partial<ApiErrorBody> & { message?: unknown };
    if (typeof body.error?.message === "string") return body.error.message;
    if (typeof body.message === "string") return body.message;
  }
  if (error instanceof Error) return refusalReason(error) ?? error.message;
  return String(error);
}

export function useProfiles(options: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: profileKeys.list(),
    queryFn: () => apiGet<{ items: ProfileSummary[] }>("/api/v1/profiles").then((res) => res.items),
  });
}

export function useProfile(id: string | null | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: (options.enabled ?? true) && Boolean(id),
    queryKey: profileKeys.detail(id ?? ""),
    queryFn: () => apiGet<ProfileDetail>(`/api/v1/profiles/${id}`),
  });
}

export function useCreateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProfileRequest) => apiPost<ProfileSummary>("/api/v1/profiles", input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: profileKeys.all });
    },
  });
}

export function useUpdateProfile(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateProfileRequest) =>
      apiPatch<ProfileSummary>(`/api/v1/profiles/${id}`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: profileKeys.all });
    },
  });
}

export function useArchiveProfile(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<ProfileSummary>(`/api/v1/profiles/${id}/archive`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: profileKeys.all });
    },
  });
}

/** Writes a profile's package edits. A refusal comes back as an Error with the server's message. */
export async function updateProfilePackages(
  id: string,
  input: { upserts?: OrgPackageEdit[]; removals?: string[] },
): Promise<{ items: OrgPackageEntry[]; ensureApprovals?: PackageEnsureApprovalView[] }> {
  try {
    return await apiPatch(`/api/v1/profiles/${id}/packages`, input);
  } catch (error) {
    throw new Error(profileErrorMessage(error));
  }
}

/** Sets one profile-scope setting, optionally locking it. `clear` goes back to the org's value. */
export async function setProfileSetting(
  id: string,
  input: { key: string; value: unknown; locked?: boolean; clear?: boolean },
): Promise<void> {
  try {
    await apiPatch("/api/v1/config/settings", { scopeType: "profile", scopeId: id, ...input });
  } catch (error) {
    throw new Error(profileErrorMessage(error));
  }
}

/** Moves a machine to another profile, or off one. */
export async function setMachineProfile(machineId: string, profileId: string | null) {
  try {
    return await apiPut<{ id: string; profileId: string | null }>(
      `/api/v1/machines/${machineId}/profile`,
      { profileId },
    );
  } catch (error) {
    throw new Error(profileErrorMessage(error));
  }
}
