import { createRoute } from "@tanstack/react-router";

import { rootRoute } from "../route-tree";
import { ApprovalsPage } from "./approvals-page";

export const approvalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/approvals",
  component: ApprovalsPage,
});
