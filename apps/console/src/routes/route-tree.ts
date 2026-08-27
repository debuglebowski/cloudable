import { createRootRoute, createRoute } from "@tanstack/react-router";

import { archiveRoute } from "./archive/route";
import { IndexPage } from "./index";
import { RootLayout } from "./root";

// Exported so feature units' own route modules (e.g. src/routes/archive/route.ts) can import it
// for `getParentRoute: () => rootRoute` — see the additive-registration convention below.
export const rootRoute = createRootRoute({
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

export const routeTree = rootRoute.addChildren([indexRoute, archiveRoute]);
