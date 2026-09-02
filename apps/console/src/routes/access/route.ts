import { createRoute } from "@tanstack/react-router";

import { rootRoute } from "../route-tree";
import { AccessPage } from "./page";
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
