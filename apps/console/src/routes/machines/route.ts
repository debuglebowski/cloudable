import { createRoute } from "@tanstack/react-router";

import { rootRoute } from "../route-tree";
import { MachineDetailPage } from "./machine-detail-page";
import { MachinesPage } from "./machines-page";

export const machinesListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/machines",
  component: MachinesPage,
});

export const machinesDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/machines/$machineId",
  component: MachineDetailPage,
});
