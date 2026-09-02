import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiGet, apiPost } from "@/lib/api-client";
import { CURRENT_ORG_ID } from "@/lib/current-org";
import { CURRENT_PERSON_ID } from "@/lib/current-person";

/**
 * Console-side data layer for owner notifications ("owner
 * notified"), wired to the real `apps/control-plane/src/http/routes/
 * notifications.ts` (this unit). Mirrors `./approvals.ts`'s
 * `usePendingApprovalsCount` exactly, per this unit's own instructions:
 * one query, shared between anything that lists notifications and the nav
 * badge, so the two can never disagree and never double-poll.
 */

// The wire shape and the console model are identical today (no name
// resolution to do, unlike `./approvals.ts`'s `Approval`) — one type, not
// two kept in sync by hand.
export interface OwnerNotification {
  id: string;
  elevationId: string;
  message: string;
  createdAt: string;
  readAt: string | null;
}

export const notificationKeys = {
  all: ["notifications"] as const,
  list: () => [...notificationKeys.all, "list"] as const,
};

export async function fetchNotifications(): Promise<OwnerNotification[]> {
  const res = await apiGet<{ items: OwnerNotification[] }>(
    `/api/v1/notifications?orgId=${CURRENT_ORG_ID}&personId=${CURRENT_PERSON_ID}`,
  );
  return res.items;
}

export function useNotificationsQuery() {
  return useQuery({
    queryKey: notificationKeys.list(),
    queryFn: fetchNotifications,
    refetchInterval: 15_000,
  });
}

/** Backs the nav item's live badge (registered in `src/nav-config.ts`) — the count of notifications not yet read. */
export function useUnreadNotificationsCount(): number | undefined {
  const { data } = useNotificationsQuery();
  return data?.filter((n) => n.readAt === null).length;
}

/**
 * Marks every unread notification for this person read — there is no
 * per-notification UI yet, so `AccessPage` (where the nav badge points)
 * fires this once on mount, closing the loop: visiting Access clears the
 * badge instead of it only ever growing.
 */
export function useMarkNotificationsReadMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiPost<{ updated: number }>("/api/v1/notifications/read", {
        orgId: CURRENT_ORG_ID,
        personId: CURRENT_PERSON_ID,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}
