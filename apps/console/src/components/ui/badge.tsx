import { type VariantProps, cva } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-1 focus:ring-ring",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-muted text-foreground",
        destructive: "border-transparent bg-destructive text-destructive-foreground",
        outline: "border-border text-foreground",
        ok: "border-transparent bg-ok-soft text-ok",
        drift: "border-transparent bg-drift-soft text-drift",
        stale: "border-transparent bg-stale-soft text-stale",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /**
   * Small leading dot (currentColor) before the label — the reference product's
   * own treatment for a neutral "at rest" status (sequences.png's outline
   * "● Draft" pill: idle, not a failure and not an achieved state). Opt-in per
   * usage, not baked into a variant: `secondary` also backs plain count/label
   * pills (NavBadge's unread count, Archive's "Legal hold" flag) that aren't a
   * resting-status label, so those stay dot-free.
   */
  dot?: boolean;
}

function Badge({ className, variant, dot, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot && (
        <span className="mr-1 size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      )}
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
