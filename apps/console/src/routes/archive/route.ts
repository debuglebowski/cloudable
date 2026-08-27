import { createRoute } from "@tanstack/react-router";

import { rootRoute } from "../route-tree";
import { ArchivePage } from "./page";

export const archiveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/archive",
  component: ArchivePage,
});
