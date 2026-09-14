import { createRoute } from "@tanstack/react-router";

import { rootRoute } from "../route-tree";
import { AccessPage } from "./page";
import { SessionFilesPage } from "./session-files-page";
import { SessionTerminalPage } from "./session-terminal-page";

export const accessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/access",
  component: AccessPage,
});

/** Web terminal — attaches to a minted session by id. See
 * `session-terminal-page.tsx`'s own doc comment for the two real entry points. */
export const accessSessionTerminalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/access/sessions/$sessionId/terminal",
  component: SessionTerminalPage,
});

/** File interface — attaches to a minted `method: "files"` session by id. Its own route
 * rather than a tab on the machine page, because it IS a session: it holds a signed token,
 * shows up in the Access list, is terminable, and is closed by the re-authorization sweep
 * when the elevation behind it lapses. A tab would make that lifetime implicit. */
export const accessSessionFilesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/access/sessions/$sessionId/files",
  component: SessionFilesPage,
});
