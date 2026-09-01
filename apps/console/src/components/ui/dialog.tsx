import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

// Every primitive below forwards its ref (Radix's `Portal`/`Presence`/focus-trap
// machinery attaches one directly to the rendered element) — see the same note on
// `Button` in button.tsx for what breaks without it.
const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    // `bg-black/20`, not `bg-foreground/20`: a modal scrim needs to stay a fixed
    // dark dim regardless of theme. `--foreground` flips to near-white in dark
    // mode, which would turn "dim the backdrop" into "flash it white" — black
    // at a fixed low opacity gives the same light-mode weight this had before
    // and does the right thing in dark mode too.
    className={cn("fixed inset-0 z-50 bg-black/20", className)}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // No border — a floating panel reads as elevated purely by shadow +
        // radius, the same way Card is distinguished from the page by color
        // alone rather than a boxed-in outline (see card.tsx). Shadow and
        // radius are both ground-truthed now, not pixel-sampled: inspected the
        // reference product's own real command-palette modal (a big centered
        // panel over a dimmed backdrop, the same shape as this component) and
        // its computed style is a genuinely different, richer recipe than the
        // single-layer shadow Card/Popover/the sidebar all share — three
        // layers (`0_1px_2px` / `0_2px_5px` / `0_2px_20px`, rgba opacities
        // 0.05/0.1/0.1) and a full `rounded-3xl` (24px), rounder than
        // anything else measured so far. A big modal apparently gets a
        // stronger, more dramatic elevation treatment than an in-page card or
        // anchored popover — not scaled up hand-tuning, this is what's
        // actually there.
        "fixed left-1/2 top-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 rounded-3xl bg-card p-6 shadow-[0_1px_2px_0_rgba(0,0,0,0.05),0_2px_5px_0_rgba(0,0,0,0.1),0_2px_20px_0_rgba(0,0,0,0.1)]",
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-1 focus:ring-ring disabled:pointer-events-none">
        <X className="size-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("flex flex-col gap-1.5 text-center sm:text-left", className)} {...props} />
  );
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:gap-2", className)}
      {...props}
    />
  );
}

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold leading-none tracking-tight", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
