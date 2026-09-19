import { useParams } from "@tanstack/react-router";

import { TerminalSession } from "@/components/terminal/terminal-session";
import { SessionBreadcrumb } from "./session-breadcrumb";

/**
 * Attaches to an already-minted session by id — reached either from the
 * machine detail page's "Connect" dialog (a fresh mint, see `../machines/connect-terminal-
 * dialog.tsx`) or from the Access page or the machine's own Sessions tab, rejoining an existing
 * `method: "terminal"` session row (no re-mint — the attach endpoint replays the already-stored
 * token, see `../../api/access.ts`'s `useMintSession` doc comment for why minting is
 * fresh-only). One page either way: attaching is always by `sessionId` at the protocol
 * level, so there's nothing route-specific left to differ on once a session exists.
 */
export function SessionTerminalPage() {
  const { machineId, sessionId } = useParams({
    from: "/machines/$machineId/sessions/$sessionId/terminal",
  });

  return (
    // h-full min-h-0: bounds this page to `main`'s real available height (see
    // root.tsx's wrapper comment) so TerminalSession's own flex-1 has a
    // definite size to grow into instead of falling back to a fixed vh guess.
    <div className="flex h-full min-h-0 flex-col gap-4">
      <SessionBreadcrumb machineId={machineId} leaf="Terminal" />
      <TerminalSession sessionId={sessionId} />
    </div>
  );
}
