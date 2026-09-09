import { ChevronRight, Plus } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

export interface CollapsibleSectionProps {
  /** Plain text, or a node when a caller needs to compose in an inline indicator
   * (e.g. a status checkmark) beside the text. */
  label: React.ReactNode;
  /** Optional item count shown next to the label (e.g. "Contacts 2"). */
  count?: number;
  /** Optional muted description rendered above the content when open. */
  description?: string;
  /** Renders a trailing "+" button when set — e.g. "add a deal to this record". */
  onAdd?: () => void;
  addLabel?: string;
  /** Arbitrary trailing header content (e.g. a text action button) — a sibling of
   * the toggle, not nested inside it, and always visible regardless of `open`. */
  headerAction?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}

/**
 * A chevron-toggle header over content, no card box/shadow of its own — distinct
 * from `Card` (components/ui/card.tsx), which is a self-contained panel rather
 * than a collapsible sub-section. Used by the Add Machine wizard's Review step
 * (`machines/add-machine-dialog.tsx`) for its three summary sections; wrap in a
 * bordered `className` when a caller wants a boxed look instead of a borderless
 * nesting.
 */
export function CollapsibleSection({
  label,
  count,
  description,
  onAdd,
  addLabel,
  headerAction,
  defaultOpen = true,
  children,
  className,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-1.5 rounded-md py-2 text-left text-sm font-medium"
        >
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          {label}
          {count !== undefined && <span className="text-muted-foreground">{count}</span>}
        </button>
        {onAdd && (
          <button
            type="button"
            onClick={onAdd}
            aria-label={addLabel ?? `Add to ${label}`}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Plus className="size-3.5" />
          </button>
        )}
        {headerAction}
      </div>
      {open && (
        <div className="flex flex-col gap-2 pb-4 pt-1 pl-5">
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
          {children}
        </div>
      )}
    </div>
  );
}
