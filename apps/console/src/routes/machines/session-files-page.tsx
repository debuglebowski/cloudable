import { useParams } from "@tanstack/react-router";

import { FileBrowser } from "@/components/files/file-browser";
import { useFileSession } from "@/components/files/use-file-session";
import { SessionBreadcrumb } from "./session-breadcrumb";

/**
 * Attaches to an already-minted `method: "files"` session by id — reached either from the
 * machine detail page's "Files" dialog (a fresh mint, see `../machines/browse-files-
 * dialog.tsx`) or from the Access page or the machine's own Sessions tab, on an existing `files` session row (no
 * re-mint; the attach endpoint replays the already-stored token). Same shape as
 * `session-terminal-page.tsx`, for the same reason: attaching is always by `sessionId` at
 * the protocol level, so there is nothing route-specific left to differ on once a session
 * exists.
 */
export function SessionFilesPage() {
  const { machineId, sessionId } = useParams({
    from: "/machines/$machineId/sessions/$sessionId/files",
  });
  // The websocket transport. `FileBrowser` itself is transport-agnostic now — a snapshot
  // inspection renders the same component over an HTTP one.
  const session = useFileSession(sessionId);

  return (
    // h-full min-h-0: bounds this page to `main`'s real available height (see root.tsx's
    // wrapper comment) so the listing's own bounded box has a definite size to shrink
    // within, instead of falling back to a fixed vh guess.
    <div className="flex h-full min-h-0 flex-col gap-4">
      <SessionBreadcrumb machineId={machineId} leaf="Files" />
      <FileBrowser session={session} />
    </div>
  );
}
