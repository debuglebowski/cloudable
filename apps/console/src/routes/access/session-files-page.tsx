import { Link, useParams } from "@tanstack/react-router";

import { FileBrowser } from "@/components/files/file-browser";

/**
 * Attaches to an already-minted `method: "files"` session by id — reached either from the
 * machine detail page's "Files" dialog (a fresh mint, see `../machines/browse-files-
 * dialog.tsx`) or from the Access page's action on an existing `files` session row (no
 * re-mint; the attach endpoint replays the already-stored token). Same shape as
 * `session-terminal-page.tsx`, for the same reason: attaching is always by `sessionId` at
 * the protocol level, so there is nothing route-specific left to differ on once a session
 * exists.
 */
export function SessionFilesPage() {
  const { sessionId } = useParams({ from: "/access/sessions/$sessionId/files" });

  return (
    // h-full min-h-0: bounds this page to `main`'s real available height (see root.tsx's
    // wrapper comment) so the listing's own bounded box has a definite size to shrink
    // within, instead of falling back to a fixed vh guess.
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
        <Link to="/access" className="hover:text-foreground hover:underline">
          Access
        </Link>
        <span aria-hidden="true">/</span>
        <span className="text-foreground">Files</span>
      </div>
      <FileBrowser sessionId={sessionId} />
    </div>
  );
}
