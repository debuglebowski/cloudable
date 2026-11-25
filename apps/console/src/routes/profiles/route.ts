import { createRoute } from "@tanstack/react-router";

import { gatePage } from "@/components/role-gate";

import { rootRoute } from "../route-tree";
import { ProfileDetailPage } from "./profile-detail-page";
import { ProfilesPage } from "./profiles-page";

export const profilesListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/profiles",
  component: gatePage(ProfilesPage, "admin"),
});

export const profileDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/profiles/$profileId",
  component: gatePage(ProfileDetailPage, "admin"),
});
