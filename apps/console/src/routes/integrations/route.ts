import { createRoute } from "@tanstack/react-router";

import { rootRoute } from "../route-tree";
import { IntegrationsPage } from "./page";

export const integrationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/integrations",
  component: IntegrationsPage,
});
