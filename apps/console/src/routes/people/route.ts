import { createRoute } from "@tanstack/react-router";

import { gatePage } from "@/components/role-gate";

import { rootRoute } from "../route-tree";
import { PeoplePage } from "./people-page";

export const peopleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/people",
  component: gatePage(PeoplePage, "admin"),
});
