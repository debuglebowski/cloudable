import { Link, useParams } from "@tanstack/react-router";

import { FileBrowser } from "@/components/files/file-browser";
import { useSnapshotInspection } from "@/components/files/use-snapshot-inspection";
import { useSearch } from "@tanstack/react-router";

/**
 * Browses one snapshot's persistent disk, read-only.
 *
 * Reached from the Archive page after `POST .../inspections` has already decided the
 * caller may look — this page attaches to a session that exists, exactly as
 * `access/session-files-page.tsx` does for a live machine. The difference is the
 * transport underneath (`useSnapshotInspection`, plain HTTP, no daemon) and that nothing
 * here can write.
 */
export function SnapshotFilesPage() {
  const { sessionId } = useParams({ from: "/inspections/$sessionId" });
  const { root } = useSearch({ from: "/inspections/$sessionId" });
  const session = useSnapshotInspection(sessionId);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
        <Link to="/archive" className="hover:text-foreground hover:underline">
          Archive
        </Link>
        <span aria-hidden="true">/</span>
        <span className="text-foreground">Snapshot files</span>
      </div>
      <FileBrowser
        session={session}
        initialPath={root}
        readOnly
        // Said plainly rather than left to be discovered by a missing directory. A
        // snapshot holds the persistent disk; /etc and /var/log were on the OS disk and
        // are not in here.
        notice="This is the machine's persistent disk as it was when the snapshot was taken — the volume mounted at /home. The OS disk is not included, and nothing here can be changed."
      />
    </div>
  );
}
