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
 * Top-level, NOT under `/archive`. The Archive page is a read-only fleet overview with no
 * actions on it; this browser is reached from a machine's Snapshots tab, which is the one
 * place that lists every snapshot rather than only the one archiving took. A URL saying
 * `/archive/...` would describe a path through the console that no longer exists.
 *
 * The file still sits beside the Archive page because the snapshot vocabulary it shares —
 * `snapshot-format`, `restore-dialog`, `legal-hold-dialog` — lives here and is consumed by
 * the machine tab too.
 *
 * `root` rides in the query string because the server decides it (the machine's home
 * directory, from `MACHINE_OS_USER`) and the client should not re-derive it.
 */
export const archiveInspectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inspections/$sessionId",
  component: SnapshotFilesPage,
  validateSearch: (search: Record<string, unknown>): { root: string } => ({
    root: typeof search.root === "string" && search.root.startsWith("/") ? search.root : "/home",
  }),
});
