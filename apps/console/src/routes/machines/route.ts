import { createRoute } from "@tanstack/react-router";

import { rootRoute } from "../route-tree";
import { MachineDetailPage } from "./machine-detail-page";
import { MachinesPage } from "./machines-page";
import { SessionFilesPage } from "./session-files-page";
import { SessionTerminalPage } from "./session-terminal-page";

export const machinesListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/machines",
  component: MachinesPage,
});

export const machinesDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/machines/$machineId",
  component: MachineDetailPage,
});

/**
 * Web terminal — attaches to a minted session by id.
 *
 * Under `/machines`, not `/access`, because a session is something you open on a machine:
 * both entry points start from the machine (its "Connect" button mints one; the Access
 * page and the machine's own Sessions tab rejoin one that exists). The URL used to say
 * `/access/...` whichever way you arrived, and the breadcrumb sent you to a page you had
 * never been on. `machineId` is in the path so the page can name where it is without
 * fetching the session first.
 *
 * The Access page keeps the fleet-wide list. It is the only place that answers "who is
 * connected right now, anywhere" and that question is not per-machine.
 */
export const machineSessionTerminalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/machines/$machineId/sessions/$sessionId/terminal",
  component: SessionTerminalPage,
});

/** File interface — attaches to a minted `method: "files"` session by id. Its own route
 * rather than a tab on the machine page, because it IS a session: it holds a signed token,
 * shows up in the Access list, is terminable, and is closed by the re-authorization sweep
 * when the elevation behind it lapses. A tab would make that lifetime implicit. */
export const machineSessionFilesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/machines/$machineId/sessions/$sessionId/files",
  component: SessionFilesPage,
});
