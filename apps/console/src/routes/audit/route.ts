import { createRoute } from "@tanstack/react-router";

import { rootRoute } from "../route-tree";
import { AuditPage } from "./audit-page";

export const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/audit",
  component: AuditPage,
});
