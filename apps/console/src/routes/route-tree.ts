import { createRootRoute, createRoute } from "@tanstack/react-router";

import { IndexPage } from "./index";
import { RootLayout } from "./root";

const rootRoute = createRootRoute({
  component: RootLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: IndexPage,
});

// Additive-registration convention: feature units own a route module under
// their own domain directory (e.g. src/routes/machines/route.ts) exporting a
// route built with `createRoute({ getParentRoute: () => rootRoute, ... })`.
// Import it here and append it to the children array below — never reorder or
// remove existing entries, only add new ones. Example:
//
//   import { machinesRoute } from "./machines/route";
//
//   export const routeTree = rootRoute.addChildren([
//     indexRoute,
//     machinesRoute,
//   ]);

export const routeTree = rootRoute.addChildren([indexRoute]);
