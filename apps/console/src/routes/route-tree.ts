import { createRootRoute, createRoute } from "@tanstack/react-router";

import { approvalsRoute } from "./approvals/route";
import { IndexPage } from "./index";
import { RootLayout } from "./root";

// Exported so feature units' route modules can import it for `getParentRoute: () =>
// rootRoute` (see the convention below). Importing it is not enough to wire up a
// route on its own — the route object still has to be appended to the
// `rootRoute.addChildren([...])` array below, since `main.tsx` builds the app's
// router solely from this file's exported `routeTree`. Never call `.addChildren`
// anywhere but here.
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

export const routeTree = rootRoute.addChildren([indexRoute, approvalsRoute]);
