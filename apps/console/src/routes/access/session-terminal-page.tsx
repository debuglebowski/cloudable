import { Link, useParams } from "@tanstack/react-router";

import { TerminalSession } from "@/components/terminal/terminal-session";

/**
 * Attaches to an already-minted session by id — reached either from the
 * machine detail page's "Connect" dialog (a fresh mint, see `../machines/connect-terminal-
 * dialog.tsx`) or from the Access page's "Connect" action on an existing `method:
 * "terminal"` session row (no re-mint — the attach endpoint replays the already-stored
 * token, see `../../api/access.ts`'s `useMintSession` doc comment for why minting is
 * fresh-only). One page either way: attaching is always by `sessionId` at the protocol
 * level, so there's nothing route-specific left to differ on once a session exists.
 */
export function SessionTerminalPage() {
  const { sessionId } = useParams({ from: "/access/sessions/$sessionId/terminal" });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link to="/access" className="hover:text-foreground hover:underline">
          Access
        </Link>
        <span aria-hidden="true">/</span>
        <span className="text-foreground">Terminal</span>
      </div>
      <TerminalSession sessionId={sessionId} />
    </div>
  );
}
