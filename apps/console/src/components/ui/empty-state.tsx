import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/** Icon + message shown in place of a table (header included) once a query has
 * settled with zero rows — see `Table`'s own comment for why the header
 * otherwise stays pinned; an empty table has no rows to pin it above, so this
 * replaces the whole thing rather than living inside an empty `TableBody`. */
function EmptyState({
  icon: Icon,
  title,
  description,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  className?: string;
}) {
  return (
    <div
      className={cn("flex flex-col items-center justify-center gap-3 py-16 text-center", className)}
    >
      <div className="flex size-11 items-center justify-center rounded-full bg-muted">
        <Icon className="size-5 text-muted-foreground" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      </div>
    </div>
  );
}

export { EmptyState };
