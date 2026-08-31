import type * as React from "react";

import { cn } from "@/lib/utils";

export type LabelProps = React.LabelHTMLAttributes<HTMLLabelElement>;

/**
 * Plain native `<label>`, not a Radix `@radix-ui/react-label` wrapper — that package isn't a
 * console dependency yet, and a form label has no accessibility behavior beyond the native
 * element's own `htmlFor` association. `setting-dialogs.tsx` already imported this path before
 * this file existed (a pre-existing gap, not introduced by the region unit).
 */
function Label({ className, ...props }: LabelProps) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: every call site passes htmlFor/children through ...props
    <label
      className={cn("text-sm font-medium leading-none peer-disabled:opacity-70", className)}
      {...props}
    />
  );
}

export { Label };
