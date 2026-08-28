import { createRoute } from "@tanstack/react-router";

import { rootRoute } from "../route-tree";
import { OrganisationPage } from "./page";

export const organisationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/organisation",
  component: OrganisationPage,
});
