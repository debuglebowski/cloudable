import { createRoute } from "@tanstack/react-router";

import { rootRoute } from "../route-tree";
import { LoginPage } from "./login-page";

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});
