import { apiGet } from "@/lib/api-client";
import { queryClient } from "@/lib/query-client";

/**
 * Who the console is signed in as, read from the credential it already holds
 * (`GET /api/v1/me`, itself `CurrentUserAuthentication`-gated).
 *
 * This replaces `current-org.ts`/`current-person.ts`, which were two fixed
 * ids from `apps/control-plane/scripts/seed-demo.ts` — written when no auth
 * system existed, and never revisited once one did. Against a real deployment
 * neither id matches anything:
 *
 *   - the org id made every page still passing `orgId` on the wire (Access,
 *     Compliance, Audit, Notifications, Organisation) query an org with no
 *     rows in it, so each rendered its empty state with the real data sitting
 *     right there under a different org id;
 *   - the person id sent a nonexistent actor into `organisation.updated`'s
 *     audit record, and asked for a stranger's notifications.
 *
 * Both are still wire params on those route groups, which is the actual thing
 * to fix (see `apps/control-plane/src/http/middleware/auth.ts` — the
 * middleware already resolves console and CLI credentials alike). Until each
 * group is migrated, this is where the values come from.
 *
 * Cached through the shared `queryClient` rather than a module-level `let`: a
 * plain module variable outlives a sign-out, so the next person to sign in on
 * the same tab would inherit the previous one's identity. `useSignOutMutation`
 * invalidates every query, which marks this one stale too (`fetchQuery`
 * refetches an invalidated entry regardless of `staleTime`).
 */
export interface Me {
  id: string;
  orgId: string;
  email: string;
  role: string;
}

export const meKey = ["me"] as const;

export function currentUser(): Promise<Me> {
  return queryClient.fetchQuery({
    queryKey: meKey,
    queryFn: () => apiGet<Me>("/api/v1/me"),
    // Never refetched on a timer — neither id changes under the caller, and
    // sign-out invalidation (above) is what actually clears this.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export async function currentOrgId(): Promise<string> {
  return (await currentUser()).orgId;
}

export async function currentPersonId(): Promise<string> {
  return (await currentUser()).id;
}

/** The `{type: "person", id}` actor the organisation endpoints want on every write. */
export async function currentActor(): Promise<{ type: "person"; id: string }> {
  return { type: "person", id: await currentPersonId() };
}
