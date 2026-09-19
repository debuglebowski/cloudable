import { useNavigate } from "@tanstack/react-router";

import { useOpenSnapshotInspection } from "@/api/archive";

/**
 * Opens a read-only inspection of a snapshot and navigates to the browser.
 *
 * Shared by the two tables that list snapshots — the Archive page (one archive-trigger
 * snapshot per archived machine) and a machine's own Snapshots tab (that machine's full
 * history, every trigger). They show different rows and offer the action in a different
 * shape, a menu item and a button, but the action itself is one thing: ask the server,
 * and go where it says. Duplicating that meant two places to keep the `root` query
 * parameter and the navigation target in step.
 *
 * Whether the caller may look is the server's decision and only the server's — nothing
 * here predicts it. `useOpenSnapshotInspection` surfaces the refusal, with its reason,
 * as a toast.
 */
export function useInspectSnapshot() {
  const navigate = useNavigate();
  const openInspection = useOpenSnapshotInspection();

  const inspect = (snapshotId: string) => {
    openInspection.mutate(snapshotId, {
      onSuccess: (session) => {
        void navigate({
          to: "/archive/inspections/$sessionId",
          params: { sessionId: session.sessionId },
          // The server decides the root (the machine's home directory), so it rides in
          // the query string rather than being re-derived client-side.
          search: { root: session.rootPath },
        });
      },
    });
  };

  return { inspect, isPending: openInspection.isPending };
}
