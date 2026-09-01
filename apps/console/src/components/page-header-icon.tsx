import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Small icon square before a page's <h1> title — the reference product opens
 * every list/detail page the same way (companies.png/company.png: a rounded,
 * pastel-tinted icon square directly before the title). Reuses the exact same
 * icon (and, for Machines/People, the same fixed color) as this page's
 * sidebar nav entry (see nav-config.ts's own iconColorClassName), so the
 * sidebar and the page it links to carry one visual identity rather than two.
 * Neutral pages (tools/governance, not object types — Access, Approvals,
 * Audit, Archive, Integrations, Organisation) get the plain muted square,
 * same split as the sidebar's own color convention.
 */
export function PageHeaderIcon({
  icon: Icon,
  className,
}: {
  icon: LucideIcon;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted",
        className,
      )}
    >
      <Icon className="size-4" strokeWidth={2} />
    </span>
  );
}
