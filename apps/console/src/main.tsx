import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { authKeys } from "@/api/auth";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setUnauthorizedHandler } from "@/lib/api-client";
import { queryClient } from "@/lib/query-client";
import { routeTree } from "@/routes/route-tree";

import "@/index.css";

// Any 401 from any API call means the session is gone server-side — treat it
// exactly like `useSignOutMutation`'s own `onSuccess` does (`api/auth.ts`):
// clear the session query so `root.tsx`'s guard redirects to `/login`, and
// invalidate everything else, since every other cached query was fetched
// under a session that's no longer valid.
setUnauthorizedHandler(() => {
  queryClient.setQueryData(authKeys.session, null);
  queryClient.invalidateQueries();
});

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={200}>
          <RouterProvider router={router} />
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
