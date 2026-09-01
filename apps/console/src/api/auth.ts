import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { type AuthUser, getSession, signInEmail, signOut } from "@/lib/auth-client";

/**
 * Session state for the whole console — `root.tsx`'s route guard and the
 * nav's sign-out control both read this same query, so a sign-in/sign-out
 * anywhere immediately reflects everywhere else (one query, one cache
 * entry, per the project's established convention — see e.g.
 * `api/approvals.ts`'s nav-badge-sharing comment for the same reasoning).
 */
export const authKeys = {
  session: ["session"] as const,
};

export function useSessionQuery() {
  return useQuery({
    queryKey: authKeys.session,
    queryFn: getSession,
    // A stale session read is worse than an extra request — every page
    // gates on this, so don't let react-query's global staleTime (see
    // `lib/query-client.ts`) skip a real check.
    staleTime: 0,
    retry: false,
  });
}

export function useSignInMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      signInEmail(email, password),
    onSuccess: (user: AuthUser) => {
      queryClient.setQueryData(authKeys.session, {
        session: { id: "", expiresAt: "", token: "" },
        user,
      });
      // Still invalidate (not just optimistically set above): the real
      // session row (expiresAt, token) only exists server-side post-login,
      // and every other query keyed off "am I logged in" should re-derive
      // from the real thing, not the placeholder used to unblock the guard
      // immediately.
      queryClient.invalidateQueries({ queryKey: authKeys.session });
    },
  });
}

export function useSignOutMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: signOut,
    onSuccess: () => {
      queryClient.setQueryData(authKeys.session, null);
      queryClient.invalidateQueries();
    },
  });
}
