import { Lock } from "lucide-react";
import type { ReactElement } from "react";

import { PageLoader } from "@/components/page-loader";
import { EmptyState } from "@/components/ui/empty-state";
import { type PageAccess, canSeePage, useRoleSubject } from "@/lib/role";

/**
 * Wraps a page so only the people allowed to see it get it. Everyone else sees a plain notice.
 * The control plane refuses the page's requests anyway; this just saves a screen of errors.
 */
export function gatePage(
  Page: () => ReactElement | null,
  access: Exclude<PageAccess, "everyone">,
): () => ReactElement {
  function GatedPage() {
    const subject = useRoleSubject();
    if (!subject) return <PageLoader />;
    if (!canSeePage(subject, access)) {
      return (
        <EmptyState
          icon={Lock}
          title="You don't have access to this page"
          description={
            access === "admin"
              ? "Only an admin can open this page."
              : "Only an approver or an admin can open this page."
          }
        />
      );
    }
    return <Page />;
  }
  GatedPage.displayName = `Gated(${Page.name})`;
  return GatedPage;
}
