import { createRoute } from "@tanstack/react-router";

import { gatePage } from "@/components/role-gate";

import { rootRoute } from "../route-tree";
import { IntegrationsPage } from "./page";

export const integrationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/integrations",
  component: gatePage(IntegrationsPage, "admin"),
});
