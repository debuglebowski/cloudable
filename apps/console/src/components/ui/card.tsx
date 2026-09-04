import type * as React from "react";

import { cn } from "@/lib/utils";

// border-muted-foreground/20 in both themes, not the paler --border token —
// a deliberately visible edge on every card, paired with the existing shadow
// rather than relying on shadow alone.
function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        // overflow-hidden: a full-bleed child (a `CardContent className="p-0"`
        // table, e.g. Audit's Timeline) otherwise touches the rounded corner
        // directly — its last row's `hover:bg-muted/50` then paints a sharp
        // rectangle that pokes past the curve. Safe for Radix
        // Select/Popover/Tooltip content, which portal to `document.body` and
        // never sit inside this clipping box in the first place.
        //
        // rounded-2xl (16px), not the shared `--radius` token (12px) — the
        // same live inspection measured this card's real `border-radius` at
        // 16px, exactly matching Popover's own (separately measured) value.
        // Not routed through `--radius` since that token also drives Dialog/
        // Input/Select/nav-pills, none of which have been checked against
        // ground truth yet — scoped to just this component until they are.
        "overflow-hidden rounded-2xl border border-muted-foreground/20 bg-card text-foreground shadow-[0_4px_12px_0_rgba(0,0,0,0.08)]",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5 p-4", className)} {...props} />;
}

function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("font-semibold leading-none tracking-tight", className)} {...props} />;
}

function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4 pt-0", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center p-4 pt-0", className)} {...props} />;
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
