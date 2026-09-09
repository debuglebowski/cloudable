import { createRoute } from "@tanstack/react-router";

import { rootRoute } from "../route-tree";
import { CliAuthPage } from "./cli-auth-page";

export const cliAuthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cli-auth",
  component: CliAuthPage,
});
