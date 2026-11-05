import { createRoute } from "@tanstack/react-router";

import { gatePage } from "@/components/role-gate";

import { rootRoute } from "../route-tree";
import { OrganisationPage } from "./page";

export const organisationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/organisation",
  component: gatePage(OrganisationPage, "admin"),
});
