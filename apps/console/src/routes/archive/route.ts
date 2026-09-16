import { createRoute } from "@tanstack/react-router";

import { rootRoute } from "../route-tree";
import { ArchivePage } from "./page";
import { SnapshotFilesPage } from "./snapshot-files-page";

export const archiveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/archive",
  component: ArchivePage,
});

/**
 * A sibling of `archiveRoute`, not a child — same flat shape the access session routes
 * use (`access/route.ts`), for the same reason: the browser is a full-height page of its
 * own, not a panel inside the Archive listing.
 *
 * `root` rides in the query string because the server decides it (the machine's home
 * directory, from `MACHINE_OS_USER`) and the client should not re-derive it.
 */
export const archiveInspectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/archive/inspections/$sessionId",
  component: SnapshotFilesPage,
  validateSearch: (search: Record<string, unknown>): { root: string } => ({
    root: typeof search.root === "string" && search.root.startsWith("/") ? search.root : "/home",
  }),
});
