import { createRoute } from "@tanstack/react-router";

import { rootRoute } from "../route-tree";
import { AccessPage } from "./page";

export const accessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/access",
  component: AccessPage,
});
