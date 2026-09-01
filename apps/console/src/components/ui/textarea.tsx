import * as React from "react";

import { cn } from "@/lib/utils";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

/**
 * Shared multi-line counterpart to `Input` — same border/background/focus-ring
 * treatment, deliberately no `shadow-sm` (`Input` dropped it in Phase 1 of the
 * Zero-ify pass). Extracted after the identical hand-rolled `<textarea>`
 * className showed up verbatim in three different reason-for-X dialogs
 * (decision-dialog, request-elevation-dialog, offboard-person-dialog) — two of
 * which had independently drifted to re-add a stray `shadow-sm` before being
 * caught and fixed. One shared component means that bug can't recur a third time.
 */
const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };
