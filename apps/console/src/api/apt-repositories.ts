import type {
  AptRepository,
  AptRepositoryChangeResponse,
  AptRepositoryRequest,
} from "@cloudable/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, apiGet, apiPost, refusalReason } from "@/lib/api-client";

/**
 * The org's approved apt repositories: package sources outside Ubuntu's own. Adding or
 * removing one waits for an `apt_repository` approval. Wired to
 * `apps/control-plane/src/http/routes/organisation.ts`.
 */
export const aptRepositoryKeys = { all: ["apt-repositories"] as const };

export function aptRepositoryErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.body && typeof error.body === "object") {
    const message = (error.body as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  if (error instanceof Error) return refusalReason(error) ?? error.message;
  return String(error);
}

export function useAptRepositories() {
  return useQuery({
    queryKey: aptRepositoryKeys.all,
    queryFn: () =>
      apiGet<{ items: AptRepository[] }>("/api/v1/organisation/apt-repositories").then(
        (res) => res.items,
      ),
  });
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: aptRepositoryKeys.all });
    void queryClient.invalidateQueries({ queryKey: ["approvals"] });
  };
}

export function useAddAptRepository() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: AptRepositoryRequest) =>
      apiPost<AptRepositoryChangeResponse & { fingerprint?: string }>(
        "/api/v1/organisation/apt-repositories",
        input,
      ),
    onSuccess: invalidate,
  });
}

export function useRemoveAptRepository() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      apiPost<AptRepositoryChangeResponse>(
        `/api/v1/organisation/apt-repositories/${input.id}/remove`,
        { reason: input.reason },
      ),
    onSuccess: invalidate,
  });
}
